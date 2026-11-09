/**
 * 冪等鍵用的 canonical JSON：物件鍵依 localeCompare 排序、略過 undefined，
 * 陣列保持順序，其他值交給 JSON.stringify。
 *
 * 這份輸出決定已儲存的請求雜湊；改動排序方式會讓既有的 idempotencyKey
 * 對不上，不能當成單純的格式整理。匯出格式用的碼點排序版本在
 * `export/v3/canonical.ts`，兩者不要合併。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
