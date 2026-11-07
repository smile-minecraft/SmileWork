import type { z } from "zod";
import { SIGNAL_KINDS, SIGNAL_STATUSES } from "../domain/signal.ts";
import { SmileworkError } from "../shared/errors.ts";
import { SIGNAL_ERROR_CODES } from "./errors.ts";

export interface ParseSignalInputOptions {
  /** 這個欄位不合法時改用專用的錯誤碼，例如 status 用 INVALID_STATUS。 */
  statusField?: string;
}

interface IssueSummary {
  path: string;
  message: string;
}

function issueSummaries(issues: readonly { path: readonly PropertyKey[]; message: string }[]): IssueSummary[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * 工具 handler 內的輸入檢查。MCP SDK 也會驗證 schema，但直接呼叫 handler
 * 或測試時仍要得到固定的錯誤外框，所以這裡再解析一次。
 */
export function parseSignalInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  options: ParseSignalInputOptions = {},
): z.infer<TSchema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues = issueSummaries(parsed.error.issues);
  const field = issues[0]?.path ?? null;
  const statusField = options.statusField;
  const isStatusIssue =
    statusField !== undefined &&
    issues.some((issue) => issue.path === statusField || issue.path.startsWith(`${statusField}.`));

  const details: Record<string, unknown> = { issues, field };
  if (field === "content") details.limit = 1000;
  if (issues.some((issue) => issue.path === "kind")) {
    details.allowedKinds = [...SIGNAL_KINDS];
  }
  if (isStatusIssue) {
    details.allowedStatuses = [...SIGNAL_STATUSES];
  }

  const message = isStatusIssue
    ? `訊號狀態不正確：${issues.map((issue) => issue.message).join("；")}`
    : `訊號參數不正確：${issues
        .map((issue) => (issue.path ? `${issue.path} ${issue.message}` : issue.message))
        .join("；")}`;

  throw new SmileworkError(
    isStatusIssue ? SIGNAL_ERROR_CODES.invalidStatus : SIGNAL_ERROR_CODES.validation,
    message,
    isStatusIssue
      ? "改用允許的狀態；先用 signal_list 確認目前狀態。"
      : "修正輸入後再重試；kind 只能用允許的值，content 最多 1000 字元。",
    details,
  );
}
