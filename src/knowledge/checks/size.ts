import {
  CHECK_CODES,
  DEFAULT_SIZE_BUDGET_BYTES,
  issueResult,
  severityBucket,
} from "./result.ts";
import type { CheckResult, SizedContent, SizeBudget } from "./types.ts";

function contentBytes(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

/**
 * 檢查整份內容的位元組總量。單一片段自己就超過預算時，回報那個片段的
 * 欄位；只有合計超額時才回報 `files`。預算與嚴重程度可由呼叫端指定。
 */
export function checkSizeBudget(
  parts: readonly SizedContent[],
  budget: SizeBudget = { maxBytes: DEFAULT_SIZE_BUDGET_BYTES },
): CheckResult {
  const totalBytes = parts.reduce((total, part) => total + contentBytes(part.content), 0);
  if (totalBytes <= budget.maxBytes) {
    return issueResult([]);
  }

  const oversized = parts.find(
    (part) => part.field !== undefined && contentBytes(part.content) > budget.maxBytes,
  );
  const issue = {
    code: CHECK_CODES.sizeBudgetExceeded,
    field: oversized?.field ?? "files",
    message: `內容總大小 ${totalBytes} 位元組，超過預算 ${budget.maxBytes} 位元組。`,
  };
  const bucket = severityBucket(budget.severity ?? "error");
  return bucket === "errors" ? issueResult([issue]) : issueResult([], [issue]);
}
