/**
 * 伺服器端的 diff 衛生與範圍檢查：找出這項工作新增的「繞過規則／跳過測試」寫法，
 * 以及落在 scopePaths 以外的改動。只看新增的行與未追蹤檔案，舊程式碼不受影響。
 *
 * 合理的例外用工作的 ruling 記錄：ruling 提到規則名稱（例如 ts-expect-error）只放行
 * 該規則，提到 diff-hygiene 放行所有衛生發現，提到 scope-override 放行範圍外改動。
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  return {
    ...base,
    files: [...new Set([...changed, ...untracked])].sort(),
    findings,
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

  return {
    findings,
    scopeViolations,
    exemptedFindings: changes.findings.length - findings.length,
    exemptedScopeViolations: outOfScope.length - scopeViolations.length,
  };
}
