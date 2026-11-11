/**
 * 伺服器驗證證據：完整輸出寫到 SMILEWORK_HOME/evidence/，資料庫只留
 * 路徑、sha256、exitCode、duration 與摘要。server_issued 固定為 1。
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Actor } from "../domain/actor.ts";
import { atomicWriteFile } from "../shared/atomic-write.ts";
import { newId, sha256Hex } from "../shared/hash.ts";
import { smileworkHome } from "../shared/paths.ts";
import { nowIso } from "../shared/time.ts";
import type { VerificationRunResult } from "./run.ts";

export interface VerificationEvidenceInput {
  db: Database;
  home: string;
  projectId: string;
  workId: string;
  actor: Actor;
  result: VerificationRunResult;
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
}

export function buildVerificationSummary(result: VerificationRunResult): string {
  const outcome = result.timedOut ? "逾時" : result.passed ? "通過" : "失敗";
  const exit = result.exitCode === null ? "無" : String(result.exitCode);
  const truncated = result.truncated ? "，輸出已截斷" : "";
  const hint = result.hint === null ? "" : "；工具鏈可能不一致，見 hint";
  return `verify_run ${result.runner} ${result.script}：${outcome}（exit ${exit}，${result.durationMs} ms${truncated}）${hint}`;
}

export function buildVerificationOutput(result: VerificationRunResult): string {
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
 * 先寫完整輸出檔，再插入資料列。插入失敗時刪掉剛寫的檔案，避免留下
 * 沒有資料列指到的孤兒檔。
 */
export function writeVerificationEvidence(input: VerificationEvidenceInput): VerificationEvidenceRecord {
  const result = input.result;
  const summary = buildVerificationSummary(result);
  const output = buildVerificationOutput(result);
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
  });

  try {
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
  };
}
