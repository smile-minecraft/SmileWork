import { ERROR_CODES, SmileworkError } from "./errors.ts";

/**
 * 只抓格式明確、誤判少的樣式：私鑰、常見平台 token、雲端存取金鑰與
 * `password=...` 這類賦值。錯誤訊息不得回顯命中的內容。
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z0-9 ]*PRIVATE KEY)-----/g;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----/g;
const TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g;
const ASSIGNMENT =
  /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/gi;

const PATTERNS: readonly RegExp[] = [PRIVATE_KEY_BLOCK, PRIVATE_KEY_HEADER, TOKEN, ASSIGNMENT];

function nonGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace("g", ""));
}

export function containsSecret(text: string): boolean {
  return PATTERNS.some((pattern) => nonGlobal(pattern).test(text));
}

/** 把命中的片段換成 [REDACTED]，保留前後文供人理解。 */
export function redactSecrets(text: string): string {
  let output = text;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function assertNoSecrets(text: string, field: string): void {
  if (!containsSecret(text)) return;
  throw new SmileworkError(
    ERROR_CODES.secretDetected,
    `欄位 ${field} 含有疑似機密，已拒絕寫入。`,
    "移除憑證或改用環境變數；不要把手動貼上的 token 寫進知識或訊號。",
    { field },
  );
}
