/**
 * 伺服器驗證證據：完整輸出寫到 SMILEWORK_HOME/evidence/，資料庫只留
 * 路徑、sha256、exitCode、duration、摘要與工作區 git 指紋。server_issued 固定為 1。
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { withImmediateTransaction } from "../db/transaction.ts";
import type { Actor } from "../domain/actor.ts";
import { atomicWriteFile } from "../shared/atomic-write.ts";
import { newId, sha256Hex } from "../shared/hash.ts";
import { smileworkHome } from "../shared/paths.ts";
import { nowIso } from "../shared/time.ts";
import { captureGitWorkspaceState, type GitWorkspaceState } from "./git-state.ts";
import type { VerificationRunResult } from "./run.ts";

export interface VerificationEvidenceInput {
  db: Database;
  home: string;
  projectId: string;
  workId: string;
  actor: Actor;
  result: VerificationRunResult;
  /** 擷取指紋的專案根目錄；省略時用 result.cwd。 */
  projectRoot?: string;
  /** 執行前擷取的工作區狀態；與執行後不同時，證據記錄執行前的指紋並標示變動。 */
  gitStateBefore?: GitWorkspaceState;
}

/** 證據記錄的工作區狀態；treeChangedDuringRun 表示驗證期間工作區被改動。 */
export interface EvidenceGitState extends GitWorkspaceState {
  treeChangedDuringRun: boolean;
}

export interface VerificationEvidenceRecord {
  evidenceId: string;
  /** 資料庫的 kind；verify_run 在既有 evidence 映射中存成 command。 */
  kind: "command";
  reportedKind: "verify_run";
  summary: string;
  command: string;
  outputPath: string;
  sha256: string;
  exitCode: number | null;
  durationMs: number;
  serverIssued: true;
  gitHead: string | null;
  workingTreeClean: boolean | null;
  treeFingerprint: string | null;
  treeChangedDuringRun: boolean;
}

export function buildVerificationSummary(result: VerificationRunResult): string {
  const outcome = result.timedOut ? "逾時" : result.passed ? "通過" : "失敗";
  const exit = result.exitCode === null ? "無" : String(result.exitCode);
  const truncated = result.truncated ? "，輸出已截斷" : "";
  const hint = result.hint === null ? "" : "；工具鏈可能不一致，見 hint";
  return `verify_run ${result.runner} ${result.script}：${outcome}（exit ${exit}，${result.durationMs} ms${truncated}）${hint}`;
}

export function buildVerificationOutput(
  result: VerificationRunResult,
  git: EvidenceGitState | null = null,
): string {
  return [
    "# verify_run",
    `runner: ${result.runner}`,
    `script: ${result.script}`,
    `command: ${JSON.stringify(result.command)}`,
    `cwd: ${result.cwd}`,
    `exitCode: ${result.exitCode === null ? "null" : result.exitCode}`,
    `signal: ${result.signal === null ? "null" : String(result.signal)}`,
    `durationMs: ${result.durationMs}`,
    `timedOut: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
    `timeoutMs: ${result.timeoutMs}`,
    `maxOutputBytes: ${result.maxOutputBytes}`,
    `hint: ${result.hint ?? "null"}`,
    "serverIssued: true",
    `gitHead: ${git?.gitHead ?? "null"}`,
    `workingTreeClean: ${git?.workingTreeClean ?? "null"}`,
    `treeFingerprint: ${git?.treeFingerprint ?? "null"}`,
    `treeChangedDuringRun: ${git?.treeChangedDuringRun ?? false}`,
    "",
    "## stdout",
    "",
    result.stdout,
    "",
    "## stderr",
    "",
    result.stderr,
    "",
  ].join("\n");
}

export function smileworkHomeForDatabase(db: Database): string {
  if (db.filename && db.filename !== ":memory:") return dirname(db.filename);
  return smileworkHome();
}

/**
 * 合併執行前後的工作區狀態。驗證期間工作區被改動時保留執行前的指紋：
 * 證據對應的是執行前的程式碼，閘門會把它判成過期，要求在穩定的工作區重跑。
 */
export function resolveEvidenceGitState(
  after: GitWorkspaceState,
  before?: GitWorkspaceState,
): EvidenceGitState {
  if (!before) return { ...after, treeChangedDuringRun: false };
  const changed = before.treeFingerprint !== after.treeFingerprint;
  return { ...before, treeChangedDuringRun: changed };
}

/**
 * 先寫完整輸出檔，再插入資料列。插入失敗時刪掉剛寫的檔案，避免留下
 * 沒有資料列指到的孤兒檔。
 */
export function writeVerificationEvidence(input: VerificationEvidenceInput): VerificationEvidenceRecord {
  const result = input.result;
  const git = resolveEvidenceGitState(
    captureGitWorkspaceState(input.projectRoot ?? result.cwd),
    input.gitStateBefore,
  );
  const summary = buildVerificationSummary(result);
  const output = buildVerificationOutput(result, git);
  const sha256 = sha256Hex(output);
  const evidenceId = newId("evidence");
  const outputPath = join(input.home, "evidence", `${evidenceId}.log`);

  mkdirSync(dirname(outputPath), { recursive: true });
  atomicWriteFile(outputPath, output);

  const details = JSON.stringify({
    kind: "verify_run",
    reportedKind: "verify_run",
    tool: "verify_run",
    policy: "restricted-verification-v1",
    runner: result.runner,
    script: result.script,
    args: result.command.slice(1),
    cwd: result.cwd,
    command: result.command.join(" "),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    timeoutMs: result.timeoutMs,
    maxOutputBytes: result.maxOutputBytes,
    passed: result.passed,
    hint: result.hint,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    isGitRepo: git.isGitRepo,
    gitHead: git.gitHead,
    workingTreeClean: git.workingTreeClean,
    treeFingerprint: git.treeFingerprint,
    treeChangedDuringRun: git.treeChangedDuringRun,
  });

  try {
    withImmediateTransaction(input.db, () => {
      input.db
        .query(
          `INSERT INTO evidence (
             evidence_id, project_id, work_id, kind, actor, actor_model, summary,
             command, output, output_path, url, path, sha256, exit_code, duration_ms,
             server_issued, details, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          evidenceId,
          input.projectId,
          input.workId,
          "command",
          input.actor.name,
          input.actor.model,
          summary,
          result.command.join(" "),
          outputPath,
          sha256,
          result.exitCode,
          result.durationMs,
          details,
          nowIso(),
        );
    });
  } catch (error) {
    try {
      unlinkSync(outputPath);
    } catch {
      // 清理失敗不蓋掉資料庫錯誤。
    }
    throw error;
  }

  return {
    evidenceId,
    kind: "command",
    reportedKind: "verify_run",
    summary,
    command: result.command.join(" "),
    outputPath,
    sha256,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    serverIssued: true,
    gitHead: git.gitHead,
    workingTreeClean: git.workingTreeClean,
    treeFingerprint: git.treeFingerprint,
    treeChangedDuringRun: git.treeChangedDuringRun,
  };
}
