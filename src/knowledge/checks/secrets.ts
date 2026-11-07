import { containsSecret } from "../../shared/secrets.ts";
import { CHECK_CODES, issueResult } from "./result.ts";
import type { CheckIssue, CheckResult, TextField } from "./types.ts";

/** 逐一掃描文字欄位；命中時只回欄位名稱，不回顯機密內容。 */
export function checkSecrets(fields: readonly TextField[]): CheckResult {
  const errors: CheckIssue[] = [];

  for (const field of fields) {
    if (!containsSecret(field.content)) continue;
    errors.push({
      code: CHECK_CODES.secretDetected,
      field: field.field,
      ...(field.path === undefined ? {} : { path: field.path }),
      message: `欄位 ${field.field} 含有疑似機密，已拒絕寫入。`,
    });
  }

  return issueResult(errors);
}
