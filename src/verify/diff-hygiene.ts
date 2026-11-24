/**
 * 伺服器端的 diff 衛生與範圍檢查：找出這項工作新增的「繞過規則／跳過測試」寫法，
 * 以及落在 scopePaths 以外的改動。只看新增的行與未追蹤檔案，舊程式碼不受影響。
 *
 * 合理的例外用工作的 ruling 記錄：ruling 提到規則名稱（例如 ts-expect-error）只放行
 * 該規則，提到 diff-hygiene 放行所有衛生發現，提到 scope-override 放行範圍外改動。
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { isInsideGitWorkTree, readGitHead, runGitText } from "./git-state.ts";

export interface HygieneRule {
  rule: string;
  pattern: RegExp;
}

/** 高訊號的規則繞過與測試跳過寫法；規則名稱也是 ruling 豁免時要引用的字串。 */
export const DIFF_HYGIENE_RULES: readonly HygieneRule[] = [
  { rule: "ts-ignore", pattern: /@ts-ignore\b/ },
  { rule: "ts-expect-error", pattern: /@ts-expect-error\b/ },
  { rule: "ts-nocheck", pattern: /@ts-nocheck\b/ },
  { rule: "eslint-disable", pattern: /eslint-disable/ },
  { rule: "biome-ignore", pattern: /biome-ignore/ },
  { rule: "istanbul-ignore", pattern: /istanbul\s+ignore/ },
  { rule: "c8-ignore", pattern: /c8\s+ignore/ },
  { rule: "v8-ignore", pattern: /v8\s+ignore/ },
  { rule: "test-skip", pattern: /\b(?:test|it|describe)\.(?:skip|todo)\s*\(/ },
  { rule: "junit-disabled", pattern: /@Disabled\b/ },
  { rule: "pytest-skip", pattern: /@pytest\.mark\.skip/ },
  { rule: "rust-ignore", pattern: /#\[ignore\]/ },
  { rule: "rust-allow", pattern: /#\[allow\(/ },
  { rule: "noqa", pattern: /#\s*noqa\b/ },
  { rule: "type-ignore", pattern: /#\s*type:\s*ignore\b/ },
];

export const DIFF_HYGIENE_EXEMPTION = "diff-hygiene";
export const SCOPE_OVERRIDE_EXEMPTION = "scope-override";

export interface HygieneFinding {
  rule: string;
  /** 相對於專案根目錄的路徑。 */
  path: string;
  /** 新檔案中的行號。 */
  line: number;
  snippet: string;
}

export interface WorkspaceChanges {
  /** 比較基準：工作的 baseCommit，或沒有可用 baseCommit 時的 HEAD／空樹。 */
  baseRef: string;
  baseSource: "baseCommit" | "HEAD" | "emptyTree";
  /** 相對於專案根目錄、排序後的改動檔案（含未追蹤檔案）。 */
  files: string[];
  findings: HygieneFinding[];
  /** 可前進到受信任 upstream merge-base 時，供 stale-base 診斷使用。 */
  upstreamBase?: UpstreamBaseInfo;
}

export interface UpstreamBaseInfo {
  /** 受信任 upstream 與目前 HEAD 的 merge-base。 */
  baseRef: string;
  /** 例如 origin/main。 */
  upstreamRef: string;
  /** 舊基準到新基準之間由上游帶入的檔案。 */
  changedFiles: string[];
  /** 新基準到目前工作區仍被改動的檔案；untracked 檔案不在此清單。 */
  worktreeChangedFiles: string[];
}

export interface BaseCommitRefresh {
  previousBaseCommit: string | null;
  baseCommit: string;
  upstreamRef: string;
  changed: boolean;
}

export interface StaleBaseSummary {
  previousBaseRef: string;
  baseRef: string;
  upstreamRef: string;
  scopeViolations: string[];
  findings: HygieneFinding[];
}

export interface RulingText {
  decision: string;
  rationale: string;
  costIfWrong?: string | null;
}

export interface DiffHygieneResult {
  findings: HygieneFinding[];
  scopeViolations: string[];
  exemptedFindings: number;
  exemptedScopeViolations: number;
  /** 所有阻擋項目都只來自上游時，要求先刷新 baseCommit。 */
  staleBase?: StaleBaseSummary;
}

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET_LENGTH = 200;
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

function snippetOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_SNIPPET_LENGTH ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH)}…` : trimmed;
}

export function scanLine(path: string, line: number, text: string): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const { rule, pattern } of DIFF_HYGIENE_RULES) {
    if (pattern.test(text)) findings.push({ rule, path, line, snippet: snippetOf(text) });
  }
  return findings;
}

function unquoteDiffPath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/** 解析 `git diff -U0` 的輸出，只掃新增的行。 */
export function scanUnifiedDiff(diff: string): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  let path: string | null = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = unquoteDiffPath(line.slice(4).replace(/\t$/, ""));
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (path === null) continue;
    if (line.startsWith("+")) {
      findings.push(...scanLine(path, newLine, line.slice(1)));
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return findings;
}

function scanUntrackedFile(projectRoot: string, path: string): HygieneFinding[] {
  const absolute = join(projectRoot, path);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCANNED_FILE_BYTES) return [];
    const content = readFileSync(absolute);
    if (content.subarray(0, 8192).includes(0)) return [];
    const findings: HygieneFinding[] = [];
    content
      .toString("utf8")
      .split(/\r?\n/)
      .forEach((text, index) => findings.push(...scanLine(path, index + 1, text)));
    return findings;
  } catch {
    return [];
  }
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function tryRunGitText(projectRoot: string, args: readonly string[]): string | null {
  try {
    return runGitText(projectRoot, args).trim();
  } catch {
    return null;
  }
}

function resolveCommit(projectRoot: string, ref: string): string | null {
  const resolved = tryRunGitText(projectRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return resolved === "" ? null : resolved;
}

function isAncestor(projectRoot: string, ancestor: string, descendant: string): boolean {
  return tryRunGitText(projectRoot, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}

/** 只接受 remote-tracking 的預設分支，避免把本地 feature branch 當成可信任基準。 */
function resolveUpstreamRef(projectRoot: string): { fullRef: string; ref: string } | null {
  let remotes: string[] = [];
  try {
    remotes = runGitText(projectRoot, ["remote"])
      .split("\n")
      .map((remote) => remote.trim())
      .filter((remote) => remote.length > 0);
  } catch {
    // 沒有 remote 設定時仍允許既有 origin/* tracking refs。
  }

  const orderedRemotes = ["origin", ...remotes.filter((remote) => remote !== "origin")];
  const candidates = new Set<string>();
  for (const remote of orderedRemotes) {
    const head = tryRunGitText(projectRoot, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    if (head !== null) candidates.add(head);
    candidates.add(`refs/remotes/${remote}/main`);
    candidates.add(`refs/remotes/${remote}/master`);
  }

  for (const fullRef of candidates) {
    if (!fullRef.startsWith("refs/remotes/")) continue;
    if (resolveCommit(projectRoot, fullRef) === null) continue;
    return { fullRef, ref: fullRef.slice("refs/remotes/".length) };
  }
  return null;
}

/**
 * 由伺服器計算可前進的審查基準；呼叫端不能指定 commit。
 * 新基準必須是舊基準的後代，且來自受信任 remote-tracking 分支與 HEAD 的 merge-base。
 */
export function computeBaseCommitRefresh(
  projectRoot: string,
  baseCommit: string | null,
): BaseCommitRefresh {
  if (!isInsideGitWorkTree(projectRoot)) {
    throw new SmileworkError(
      ERROR_CODES.notGitRepository,
      "不是 git repo，無法更新 baseCommit。",
      "請在 git worktree 內呼叫，或保留原本非 git 的工作流程。",
    );
  }

  const upstream = resolveUpstreamRef(projectRoot);
  if (upstream === null) {
    throw new SmileworkError(
      "UPSTREAM_NOT_FOUND",
      "找不到受信任的 remote-tracking 上游分支。",
      "確認 repo 已設定 origin/HEAD 或 origin/main／origin/master 這類 refs/remotes/* 預設分支；必要時先 git fetch。",
    );
  }

  const head = readGitHead(projectRoot);
  if (head === null) {
    throw new SmileworkError(
      "BASE_COMMIT_UNAVAILABLE",
      "repo 目前沒有可解析的 HEAD。",
      "先建立初始 commit，再重新整理工作分支。",
    );
  }

  const nextBase = tryRunGitText(projectRoot, ["merge-base", head, upstream.fullRef]);
  if (nextBase === null || nextBase === "") {
    throw new SmileworkError(
      "UPSTREAM_NOT_FOUND",
      `HEAD 與 ${upstream.ref} 沒有可用的 merge-base。`,
      "確認分支歷史確實源自受信任上游；若使用不同整合分支，請先整理分支關係。",
      { upstreamRef: upstream.ref },
    );
  }

  let previousBase: string | null = null;
  if (baseCommit !== null) {
    if (!COMMIT_PATTERN.test(baseCommit)) {
      throw new SmileworkError(
        "BASE_COMMIT_UNAVAILABLE",
        "工作記錄的 baseCommit 不是有效的 commit 雜湊。",
        "重新讀取工作；若資料已損壞，請由維護者修正工作紀錄。",
        { baseCommit },
      );
    }
    previousBase = resolveCommit(projectRoot, baseCommit);
    if (previousBase === null) {
      throw new SmileworkError(
        "BASE_COMMIT_UNAVAILABLE",
        "工作記錄的 baseCommit 不在這個 repo。",
        "確認 worktree 與 repo 沒有被 relink 到不同歷史；必要時先由維護者修正工作紀錄。",
        { baseCommit },
      );
    }
    if (previousBase !== nextBase && !isAncestor(projectRoot, previousBase, nextBase)) {
      throw new SmileworkError(
        "BASE_COMMIT_NOT_FORWARD",
        "上游 merge-base 早於工作目前的 baseCommit，重新整理基準會把範圍往後退。",
        "先確認本地基準為何領先受信任上游；refreshBaseCommit 只允許把基準往前移。",
        { baseCommit: previousBase, candidateBaseCommit: nextBase, upstreamRef: upstream.ref },
      );
    }
  }

  return {
    previousBaseCommit: previousBase,
    baseCommit: nextBase,
    upstreamRef: upstream.ref,
    changed: previousBase !== nextBase,
  };
}

function collectUpstreamBaseInfo(projectRoot: string, baseCommit: string): UpstreamBaseInfo | null {
  try {
    const refresh = computeBaseCommitRefresh(projectRoot, baseCommit);
    if (!refresh.changed || refresh.previousBaseCommit === null) return null;
    const changedFiles = splitNul(
      runGitText(projectRoot, [
        "diff",
        "--name-only",
        "-z",
        ...DIFF_FLAGS,
        refresh.previousBaseCommit,
        refresh.baseCommit,
        "--",
        ".",
      ]),
    );
    const worktreeChangedFiles = splitNul(
      runGitText(projectRoot, ["diff", "--name-only", "-z", ...DIFF_FLAGS, refresh.baseCommit, "--", "."]),
    );
    return {
      baseRef: refresh.baseCommit,
      upstreamRef: refresh.upstreamRef,
      changedFiles: [...new Set(changedFiles)].sort(),
      worktreeChangedFiles: [...new Set(worktreeChangedFiles)].sort(),
    };
  } catch {
    // stale-base 診斷是 best-effort；沒有可信上游時維持原本的 scope／hygiene 閘門。
    return null;
  }
}

function resolveBase(
  projectRoot: string,
  baseCommit: string | null,
): Pick<WorkspaceChanges, "baseRef" | "baseSource"> {
  if (baseCommit !== null && COMMIT_PATTERN.test(baseCommit)) {
    try {
      const resolved = runGitText(projectRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${baseCommit}^{commit}`,
      ]).trim();
      if (resolved) return { baseRef: resolved, baseSource: "baseCommit" };
    } catch {
      // baseCommit 不在這個 repo（例如 relink 到別的 clone），退回 HEAD。
    }
  }
  const head = readGitHead(projectRoot);
  if (head !== null) return { baseRef: head, baseSource: "HEAD" };
  const emptyTree = runGitText(projectRoot, ["hash-object", "-t", "tree", "/dev/null"]).trim();
  return { baseRef: emptyTree, baseSource: "emptyTree" };
}

/**
 * 收集專案根目錄底下自 baseCommit（或 HEAD）以來的改動與衛生發現。
 * 不是 git repo 時回 null；git 指令失敗時丟出例外，由閘門 fail closed。
 */
export function collectWorkspaceChanges(
  projectRoot: string,
  baseCommit: string | null,
): WorkspaceChanges | null {
  if (!isInsideGitWorkTree(projectRoot)) return null;

  const base = resolveBase(projectRoot, baseCommit);
  const changed = splitNul(
    runGitText(projectRoot, ["diff", "--name-only", "-z", ...DIFF_FLAGS, base.baseRef, "--", "."]),
  );
  const diff = runGitText(projectRoot, ["diff", "-U0", ...DIFF_FLAGS, base.baseRef, "--", "."]);
  const untracked = splitNul(
    runGitText(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  );

  const findings = scanUnifiedDiff(diff);
  for (const path of untracked) findings.push(...scanUntrackedFile(projectRoot, path));

  const upstreamBase =
    base.baseSource === "baseCommit" ? collectUpstreamBaseInfo(projectRoot, base.baseRef) : null;

  return {
    ...base,
    files: [...new Set([...changed, ...untracked])].sort(),
    findings,
    ...(upstreamBase === null ? {} : { upstreamBase }),
  };
}

function normalizeScopePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

/** scopePaths 為空時不限制；完全相同或位於某個 scopePath 資料夾底下才算在範圍內。 */
export function isPathInScope(path: string, scopePaths: readonly string[]): boolean {
  if (scopePaths.length === 0) return true;
  const target = normalizeScopePath(path);
  return scopePaths.some((raw) => {
    const scope = normalizeScopePath(raw);
    if (scope === "" || scope === ".") return true;
    return target === scope || target.startsWith(`${scope}/`);
  });
}

function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

function rulingText(ruling: RulingText): string {
  return [ruling.decision, ruling.rationale, ruling.costIfWrong ?? ""].join("\n");
}

/** 套用 scopePaths 與 ruling 豁免，回傳仍然擋住的發現與範圍外檔案。 */
export function evaluateDiffHygiene(
  changes: WorkspaceChanges,
  options: { scopePaths: readonly string[]; rulings: readonly RulingText[] },
): DiffHygieneResult {
  const texts = options.rulings.map(rulingText);
  const blanketHygiene = texts.some((text) => mentions(text, DIFF_HYGIENE_EXEMPTION));
  const scopeOverride = texts.some((text) => mentions(text, SCOPE_OVERRIDE_EXEMPTION));
  const exemptRules = new Set(
    DIFF_HYGIENE_RULES.map(({ rule }) => rule).filter((rule) =>
      texts.some((text) => mentions(text, rule)),
    ),
  );

  const findings = blanketHygiene
    ? []
    : changes.findings.filter((finding) => !exemptRules.has(finding.rule));
  const outOfScope = changes.files.filter((path) => !isPathInScope(path, options.scopePaths));
  const scopeViolations = scopeOverride ? [] : outOfScope;

  let staleBase: StaleBaseSummary | undefined;
  if (changes.upstreamBase !== undefined) {
    const upstreamFiles = new Set(changes.upstreamBase.changedFiles);
    const worktreeFiles = new Set(changes.upstreamBase.worktreeChangedFiles);
    const isUpstreamOnly = (path: string): boolean =>
      upstreamFiles.has(path) && !worktreeFiles.has(path);
    const upstreamScopeViolations = scopeViolations.filter(isUpstreamOnly);
    const upstreamFindings = findings.filter((finding) => isUpstreamOnly(finding.path));
    const hasBlockingItems = findings.length > 0 || scopeViolations.length > 0;
    const allFromUpstream =
      hasBlockingItems &&
      upstreamScopeViolations.length === scopeViolations.length &&
      upstreamFindings.length === findings.length;
    if (allFromUpstream) {
      staleBase = {
        previousBaseRef: changes.baseRef,
        baseRef: changes.upstreamBase.baseRef,
        upstreamRef: changes.upstreamBase.upstreamRef,
        scopeViolations: upstreamScopeViolations,
        findings: upstreamFindings,
      };
    }
  }

  return {
    findings,
    scopeViolations,
    exemptedFindings: changes.findings.length - findings.length,
    exemptedScopeViolations: outOfScope.length - scopeViolations.length,
    ...(staleBase === undefined ? {} : { staleBase }),
  };
}
