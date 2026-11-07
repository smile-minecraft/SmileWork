import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { smileworkDatabasePath } from "../../shared/paths.ts";
import { repositoryRoot, gitRaw } from "./git.ts";

export interface AddedLine {
  path: string;
  line: number;
  text: string;
}

export interface IdFinding {
  id: string;
  path: string;
  /** 檔名命中時為 null。 */
  line: number | null;
  text: string;
}

export interface StagedCheckResult {
  registered: number;
  findings: IdFinding[];
}

export interface StagedCheckOptions {
  projectPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 讀取已登記的工作與計畫 ID。資料庫不存在時回空清單：
 * hook 是選配功能，不該因為使用者還沒建立資料庫就擋下提交。
 */
export function loadRegisteredWorkIds(env: NodeJS.ProcessEnv): string[] {
  const path = smileworkDatabasePath(env);
  if (!existsSync(path)) return [];

  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db
      .query<{ work_id: string }, []>("SELECT work_id FROM work_items ORDER BY work_id")
      .all()
      .map((row) => row.work_id);
  } finally {
    db.close();
  }
}

/** git 會用 C 字串引號包住含特殊字元的路徑；一般路徑直接使用，遇到引號再解開。 */
function decodeDiffPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function stripPrefix(path: string): string {
  return path.startsWith("b/") || path.startsWith("a/") ? path.slice(2) : path;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** 從 `git diff --cached --unified=0` 的輸出取出新增行，包含新檔案的每一行。 */
export function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let currentPath: string | null = null;
  let inHunk = false;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      continue;
    }

    if (!inHunk && raw.startsWith("+++ ")) {
      const target = decodeDiffPath(raw.slice(4));
      currentPath = target === "/dev/null" ? null : stripPrefix(target);
      continue;
    }

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1] ?? "0");
      inHunk = true;
      continue;
    }

    if (!inHunk || currentPath === null) continue;

    if (raw.startsWith("+")) {
      added.push({ path: currentPath, line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("\\ No newline")) continue;
    newLine += 1;
  }

  return added;
}

function stagedAddedLines(projectPath: string): AddedLine[] {
  const diff = gitRaw(projectPath, [
    "diff",
    "--cached",
    "--no-color",
    "--unified=0",
    "--diff-filter=ACMR",
  ]);
  return parseAddedLines(diff);
}

function stagedFileNames(projectPath: string): string[] {
  const raw = gitRaw(projectPath, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--diff-filter=ACMR",
  ]);
  return raw.split("\0").filter((name) => name !== "");
}

export function findIdLeaks(
  ids: readonly string[],
  lines: readonly AddedLine[],
  fileNames: readonly string[],
): IdFinding[] {
  const findings: IdFinding[] = [];
  const seen = new Set<string>();

  const push = (finding: IdFinding): void => {
    const key = `${finding.id}\0${finding.path}\0${finding.line ?? "name"}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const line of lines) {
    for (const id of ids) {
      if (line.text.includes(id)) {
        push({ id, path: line.path, line: line.line, text: line.text.trim().slice(0, 200) });
      }
    }
  }

  for (const name of fileNames) {
    for (const id of ids) {
      if (name.includes(id)) {
        push({ id, path: name, line: null, text: name });
      }
    }
  }

  return findings;
}

/** 比對暫存變更與已登記 ID；repo 無法解析時丟出錯誤，資料庫讀取失敗由呼叫端決定怎麼降級。 */
export function checkStagedWorkIds(options: StagedCheckOptions): StagedCheckResult {
  repositoryRoot(options.projectPath);
  const ids = loadRegisteredWorkIds(options.env);
  if (ids.length === 0) return { registered: 0, findings: [] };

  const findings = findIdLeaks(
    ids,
    stagedAddedLines(options.projectPath),
    stagedFileNames(options.projectPath),
  );
  return { registered: ids.length, findings };
}
