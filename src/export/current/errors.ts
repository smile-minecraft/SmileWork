/** 目前資料庫匯出器可預期的錯誤。 */
export class ExportCurrentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ExportCurrentError";
  }
}
