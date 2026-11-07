import type { z, ZodObject, ZodRawShape } from "zod";
import { ERROR_CODES } from "../shared/errors.ts";
import type { ToolResult } from "../shared/result.ts";
import { fail } from "../shared/result.ts";
import type { ToolContext, ToolDomain } from "./types.ts";
import type {
  ToolDefinitionWithValidation,
  ToolValidationMode,
} from "./tool.ts";

export interface DefineToolConfig<TShape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  domain: ToolDomain;
  inputSchema: ZodObject<TShape>;
  /** schema 由 runTool 統一驗證；handler 表示工具自行驗證並回固定外框。 */
  validation?: ToolValidationMode;
  handler: (
    input: z.infer<ZodObject<TShape>>,
    context: ToolContext,
  ) => Promise<ToolResult> | ToolResult;
}

/** 保留每個工具自己的輸入型別，registry 只需要統一的外層介面。 */
export function defineTool<TShape extends ZodRawShape>(
  config: DefineToolConfig<TShape>,
): ToolDefinitionWithValidation {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    domain: config.domain,
    inputSchema: config.inputSchema,
    validation: config.validation ?? "schema",
    handler: (input, context) =>
      config.handler(input as z.infer<ZodObject<TShape>>, context),
  };
}

/** 尚未實作的工具一律回固定外框，不建立資料庫或解析專案。 */
export function notImplemented(toolName: string): () => ToolResult {
  return () =>
    fail(
      ERROR_CODES.notImplemented,
      `${toolName} 尚未實作。`,
      "等對應的實作完成後再呼叫這個工具。",
      { tool: toolName },
    );
}
