/** 匯出器可預期的錯誤，帶穩定代碼讓 CLI 與測試判斷原因。 */
export class ExportV3Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ExportV3Error";
  }
}
