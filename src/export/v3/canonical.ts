import { createHash } from "node:crypto";

/**
 * 依 Unicode 碼點比較字串。JS 預設的 `<` 比的是 UTF-16 碼元，
 * 遇到代理對時順序會和碼點不同；匯出格式要求碼點排序。
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftPoints[index]!.codePointAt(0)!;
    const b = rightPoints[index]!.codePointAt(0)!;
    if (a !== b) return a - b;
  }
  return leftPoints.length - rightPoints.length;
}

export function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareCodePoints);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return sortStrings([...new Set(values)]);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareCodePoints)) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/** 緊湊 canonical JSON：鍵依碼點排序，不加空白。 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(sortKeysDeep(value));
  if (text === undefined) throw new Error("無法序列化非 JSON 值");
  return text;
}

/** 給 manifest 用的 canonical JSON，固定兩個空白縮排與結尾換行。 */
export function canonicalJsonPretty(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

/** 把值轉成 JSON Pointer 片段。 */
export function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
