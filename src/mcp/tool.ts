import type { ToolDefinition } from "./types.ts";

/**
 * 輸入驗證模式。schema 由 runTool 先用工具的 zod schema 驗證；
 * handler 表示工具在 handler 內自行驗證，runTool 直接交出原始輸入。
 */
export type ToolValidationMode = "schema" | "handler";

/** ToolDefinition 的驗證擴充欄位；沒有設定時視為 schema。 */
export interface ToolDefinitionWithValidation extends ToolDefinition {
  readonly validation?: ToolValidationMode;
}

export function usesHandlerValidation(tool: ToolDefinition): boolean {
  return (tool as ToolDefinitionWithValidation).validation === "handler";
}
