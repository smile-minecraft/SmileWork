import type { CallToolResult } from "@modelcontextprotocol/server";
import { ERROR_CODES } from "../shared/errors.ts";
import type { ToolResult } from "../shared/result.ts";
import { fail, failureFromError } from "../shared/result.ts";
import { createToolContext, type CreateToolContextOptions } from "./context.ts";
import { usesHandlerValidation } from "./tool.ts";
import type { ToolDefinition } from "./types.ts";
import { parseToolInput } from "./validation.ts";

/** MCP 一律用緊湊 JSON 文字回傳，host 可以直接解析同一個外框。 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}

export async function runTool(
  definition: ToolDefinition,
  input: Record<string, unknown>,
  contextOptions: CreateToolContextOptions = {},
): Promise<CallToolResult> {
  let value = input;
  if (!usesHandlerValidation(definition)) {
    const parsed = parseToolInput(definition.inputSchema, input);
    if (!parsed.ok) {
      const detail = parsed.issues
        .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
        .join("；");
      return toCallToolResult(
        fail(
          ERROR_CODES.validation,
          `輸入格式不正確：${detail}`,
          "依錯誤訊息修正參數後重新呼叫。",
          { issues: parsed.issues },
        ),
      );
    }
    value = parsed.value;
  }

  const context = createToolContext(contextOptions);
  try {
    return toCallToolResult(await definition.handler(value, context));
  } catch (error) {
    return toCallToolResult(failureFromError(error));
  } finally {
    context.close();
  }
}
