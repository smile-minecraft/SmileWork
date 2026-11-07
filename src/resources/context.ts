import { createToolContext } from "../mcp/context.ts";
import type { ToolContext } from "../mcp/types.ts";

/** resource 讀取只借用工具 context 的資料庫與專案解析，寫入一律不開放。 */
export function withResourceContext<T>(run: (context: ToolContext) => T): T {
  const context = createToolContext();
  try {
    return run(context);
  } finally {
    context.close();
  }
}
