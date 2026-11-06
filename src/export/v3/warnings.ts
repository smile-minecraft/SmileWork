import { compareCodePoints } from "./canonical.ts";

/** 收集 manifest.warnings，最後排序讓輸出穩定。 */
export class WarningCollector {
  private readonly messages = new Set<string>();

  add(message: string): void {
    if (message.trim() === "") return;
    this.messages.add(message);
  }

  all(): string[] {
    return [...this.messages].sort(compareCodePoints);
  }
}
