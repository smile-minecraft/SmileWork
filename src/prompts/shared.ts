import type { GetPromptResult } from "@modelcontextprotocol/server";
import { createToolContext } from "../mcp/context.ts";
import type { ToolContext } from "../mcp/types.ts";
import { loadWorkDetailById } from "../resources/work.ts";
import type { WorkDetail } from "../work/crud.ts";

/** prompt 只讀資料庫，不建立工作或知識。 */
export function withPromptContext<T>(run: (context: ToolContext) => T): T {
  const context = createToolContext();
  try {
    return run(context);
  } finally {
    context.close();
  }
}

export function textPrompt(text: string): GetPromptResult {
  return {
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

export function requireWorkDetail(context: ToolContext, workId: string): WorkDetail {
  const detail = loadWorkDetailById(context.db(), workId);
  if (!detail) throw new Error(`找不到工作：${workId}`);
  return detail;
}
