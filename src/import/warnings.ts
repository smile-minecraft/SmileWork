import { compareCodePoints } from "../export/v3/canonical.ts";

/** 收集匯入警告，最後依碼點排序，讓 CLI 輸出穩定。 */
export class WarningCollector {
  private readonly messages = new Set<string>();

  add(message: string): void {
    const trimmed = message.trim();
    if (trimmed !== "") this.messages.add(trimmed);
  }

  addAt(code: string, location: string, detail = ""): void {
    const suffix = detail === "" ? "" : `：${detail}`;
    this.add(`${code} ${location}${suffix}`);
  }

  all(): string[] {
    return [...this.messages].sort(compareCodePoints);
  }
}
