/** 判斷檔案系統錯誤是否只是路徑不存在；安裝流程用它區分「沒有 hook」與讀取失敗。 */
export function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 把未知例外轉成可讀訊息，避免 CLI 直接印出物件。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
