/**
 * pre-commit hook 的內容產生與辨識。
 * hook 由 smilework 建立，因此用固定的 marker 判斷所有權，避免覆蓋或誤刪別人的 hook。
 */

export const HOOK_MARKER = "smilework-managed-hook";
export const PRE_COMMIT_NAME = "pre-commit";

/** 實際要執行的程式；第一個元素是執行檔，其餘是參數。 */
export interface HookCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/** POSIX shell 的單引號跳脫；路徑含空白或引號時仍可執行。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderPreCommitHook(command: HookCommand): string {
  const invocation = [command.file, ...command.args].map(shellQuote).join(" ");
  return [
    "#!/bin/sh",
    `# ${HOOK_MARKER}: ${PRE_COMMIT_NAME}`,
    "# 這個檔案由 smilework hooks install 建立，用 smilework hooks uninstall 移除。",
    "# 提交前比對已登記的工作與計畫 ID，避免把內部識別碼寫進專案內容。",
    `exec ${invocation} hooks check --staged --quiet`,
    "",
  ].join("\n");
}

export function isManagedHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}
