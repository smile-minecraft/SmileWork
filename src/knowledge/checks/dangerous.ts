import { CHECK_CODES, issueResult } from "./result.ts";
import type { CheckIssue, CheckResult, CheckSeverity, TextField } from "./types.ts";

const SHELL = String.raw`(?:sh|bash|zsh|dash|ksh|fish)`;
const SHELL_COMMAND = String.raw`(?:\/(?:usr\/)?bin\/)?${SHELL}`;
const SUDO = String.raw`(?:sudo\s+(?:(?:-[A-Za-z])\s+|--[A-Za-z-]+(?:=\S+)?\s+|-u\s+\S+\s+|-g\s+\S+\s+)*)?`;
const ENV = String.raw`(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?`;

/** `curl ... | sh` 與等價的遠端腳本執行方式。 */
const CURL_PIPE_SHELL = new RegExp(
  String.raw`\b(?:curl|wget)\b[^\n]*\|\s*${SUDO}${ENV}${SHELL_COMMAND}\b`,
  "i",
);
const SHELL_PROCESS_SUBSTITUTION = new RegExp(
  String.raw`\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b`,
  "i",
);
const SHELL_EVAL_CURL = new RegExp(
  String.raw`\beval\s+["']?\$\(\s*(?:curl|wget)\b`,
  "i",
);

/**
 * 只把 `.ssh` 目錄本身或它底下的路徑視為目標；`~/.ssh-backup` 這類
 * 相似名稱不算。macOS 的檔案系統大小寫不敏感，所以用 i 旗標。
 */
const SSH_PATH = String.raw`(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/\.ssh(?:\/|(?=$|[\s"';)]))`;
const SSH_REDIRECT = new RegExp(
  String.raw`(?:>>?|tee(?:\s+-a)?|\bof=)\s*["']?${SSH_PATH}`,
  "i",
);
const SSH_WRITE_COMMAND = new RegExp(
  String.raw`\b(?:cp|mv|install|dd|sed\s+-i|ssh-keygen|ln)\b[^\n]*${SSH_PATH}`,
  "i",
);

const RM_COMMAND = /\brm\s+([^\n]*)/i;
const ROOT_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "~/*",
  "$HOME",
  "$HOME/",
  "$HOME/*",
  "${HOME}",
  "${HOME}/",
  "${HOME}/*",
]);

interface DangerousMatcher {
  code: string;
  message: string;
  test(line: string): boolean;
}

interface LogicalLine {
  text: string;
  line: number;
}

/**
 * 把反斜線續行與以 pipe 開頭的行併回同一條邏輯行，這樣換行寫的管線
 * 也偵測得到；回報的行號取邏輯行的第一行。
 */
function logicalLines(content: string): LogicalLine[] {
  const raw = content.split(/\r\n|\r|\n/);
  const result: LogicalLine[] = [];
  let buffer = "";
  let start = 1;
  let continues = false;

  const flush = (): void => {
    if (buffer.length > 0) {
      result.push({ text: buffer, line: start });
    }
    buffer = "";
  };

  raw.forEach((line, index) => {
    const lineNumber = index + 1;
    if (buffer === "") {
      buffer = line;
      start = lineNumber;
    } else if (continues || /^\s*\|/.test(line)) {
      buffer += " " + line.trim();
    } else {
      flush();
      buffer = line;
      start = lineNumber;
    }
    continues = /\\\s*$/.test(line);
  });
  flush();
  return result;
}

function cleanTarget(token: string): string {
  return token
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[;|&)\]}`]+$/g, "");
}

function hasRootRemoval(line: string): boolean {
  const match = RM_COMMAND.exec(line);
  const remainder = match?.[1];
  if (remainder === undefined) return false;

  let recursive = false;
  let force = false;
  const targets: string[] = [];

  for (const token of remainder.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("-")) {
      if (token === "--recursive") {
        recursive = true;
      } else if (token === "--force") {
        force = true;
      } else if (/^-[A-Za-z]+$/.test(token)) {
        if (token.includes("r") || token.includes("R")) recursive = true;
        if (token.includes("f")) force = true;
      }
      continue;
    }
    targets.push(cleanTarget(token));
  }

  return recursive && force && targets.some((target) => ROOT_TARGETS.has(target));
}

const MATCHERS: readonly DangerousMatcher[] = [
  {
    code: CHECK_CODES.dangerousCurlPipeShell,
    message: "內容包含把遠端腳本直接交給 shell 執行的管線。",
    test: (line) =>
      CURL_PIPE_SHELL.test(line) ||
      SHELL_PROCESS_SUBSTITUTION.test(line) ||
      SHELL_EVAL_CURL.test(line),
  },
  {
    code: CHECK_CODES.dangerousSshWrite,
    message: "內容包含寫入 ~/.ssh 的操作。",
    test: (line) => SSH_REDIRECT.test(line) || SSH_WRITE_COMMAND.test(line),
  },
  {
    code: CHECK_CODES.dangerousRmRoot,
    message: "內容包含遞迴強制刪除根目錄的操作。",
    test: hasRootRemoval,
  },
];

/** 逐行掃描危險模式；預設只警告，呼叫端可以改成錯誤來阻擋寫入。 */
export function checkDangerousPatterns(
  fields: readonly TextField[],
  severity: CheckSeverity = "warning",
): CheckResult {
  const issues: CheckIssue[] = [];

  for (const field of fields) {
    for (const line of logicalLines(field.content)) {
      for (const matcher of MATCHERS) {
        if (!matcher.test(line.text)) continue;
        issues.push({
          code: matcher.code,
          field: field.field,
          ...(field.path === undefined ? {} : { path: field.path }),
          line: line.line,
          message: matcher.message,
        });
      }
    }
  }

  return severity === "error" ? issueResult(issues) : issueResult([], issues);
}
