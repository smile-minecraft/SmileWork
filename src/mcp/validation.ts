import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { ZodObject, ZodRawShape } from "zod";

/**
 * tools/list 要看到真正的 JSON Schema，但 validation 由 runTool 統一處理，
 * 才能把錯誤換成固定外框。這個包裝保留原 schema 的 jsonSchema，只把
 * SDK 的 validate 換成永遠成功；handler 執行前仍會用原 schema safeParse。
 */
export function passThroughInputSchema(schema: ZodObject<ZodRawShape>): StandardSchemaWithJSON {
  const standard = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => ({ value }),
    },
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParsedToolInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] };

/** 在建立資料庫或解析專案之前先驗證，避免非法輸入產生副作用。 */
export function parseToolInput(schema: ZodObject<ZodRawShape>, input: unknown): ParsedToolInput {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join("."),
      message: issue.message,
    })),
  };
}
