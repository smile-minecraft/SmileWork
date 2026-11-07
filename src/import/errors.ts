/** 匯入器可預期的錯誤；CLI 與測試靠 code 判斷原因。 */
export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ImportError";
  }
}
