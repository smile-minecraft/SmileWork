import type { ZodType } from "zod";
import { KNOWLEDGE_TOOL_ERROR_CODES } from "./errors.ts";
import { SmileworkError } from "../../shared/errors.ts";

/**
 * 工具 handler 內的輸入檢查。MCP SDK 也會驗證 schema，但直接呼叫 handler
 * 或測試時仍要得到固定的錯誤外框，所以這裡再解析一次。
 */
export function parseKnowledgeInput<TOutput>(schema: ZodType<TOutput>, input: unknown): TOutput {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const field = issues[0]?.path ?? null;
  const detail = issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("；");

  throw new SmileworkError(
    KNOWLEDGE_TOOL_ERROR_CODES.validation,
    `知識參數不正確：${detail}`,
    "依錯誤訊息修正參數後重新呼叫。",
    { issues, field },
  );
}
