import { ERROR_CODES, SmileworkError } from "./errors.ts";

/** 所有工具共用的成功外框。 */
export interface ToolSuccess<T = unknown> {
  ok: true;
  summary: string;
  data: T;
}

/** 所有工具共用的失敗外框。 */
export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  nextAction: string;
  data: Record<string, unknown>;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export function ok<T>(summary: string, data: T): ToolSuccess<T> {
  return { ok: true, summary, data };
}

export function fail(
  code: string,
  message: string,
  nextAction: string,
  data: Record<string, unknown> = {},
): ToolFailure {
  return { ok: false, code, message, nextAction, data };
}

/** 把任何例外轉成固定的失敗外框，未知例外一律視為內部錯誤。 */
export function failureFromError(error: unknown): ToolFailure {
  if (error instanceof SmileworkError) {
    return fail(error.code, error.message, error.nextAction, error.data);
  }
  if (error instanceof Error) {
    return fail(
      ERROR_CODES.internal,
      error.message || "未預期的錯誤。",
      "保留錯誤訊息並回報；修正後再重試。",
      { name: error.name },
    );
  }
  return fail(ERROR_CODES.internal, String(error), "保留錯誤訊息並回報；修正後再重試。");
}
