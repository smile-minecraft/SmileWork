/**
 * 資料庫 JSON 欄位的共用解析。
 * 損壞的資料一律回 INTERNAL_ERROR，附上實體識別碼與欄位，
 * 不把壞資料當成空值，也不讓呼叫端收到沒有錯誤碼的例外。
 */

import { ERROR_CODES, SmileworkError } from "./errors.ts";
import type { ToolResult } from "./result.ts";

export interface StoredJsonRef {
  /** 給使用者看的實體名稱，例如「工作」。 */
  entity: string;
  /** 實體識別碼。 */
  id: string | number;
  /** 資料庫欄位名稱。 */
  field: string;
}

const DATA_FIX_NEXT_ACTION = "回報這個問題，並附上識別碼與資料庫路徑。";

function corrupted(ref: StoredJsonRef, reason: string): SmileworkError {
  return new SmileworkError(
    ERROR_CODES.internal,
    `${ref.entity} ${ref.id} 的 ${ref.field} ${reason}。`,
    DATA_FIX_NEXT_ACTION,
    { entity: ref.entity, id: ref.id, field: ref.field },
  );
}

function isStoredObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析一般 JSON 欄位；null 代表沒有值，其他內容必須是合法 JSON。 */
export function parseStoredJson(value: string | null, ref: StoredJsonRef): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw corrupted(ref, "不是合法 JSON");
  }
}

/** 解析以 JSON 儲存的字串陣列；損壞或含非字串元素時一律報錯。 */
export function parseStoredStringArray(value: string | null, ref: StoredJsonRef): string[] {
  const parsed = parseStoredJson(value, ref);
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw corrupted(ref, "不是字串陣列");
  }
  return parsed;
}

/** 解析 JSON 物件欄位；null 代表沒有值，其他內容必須是合法 JSON 物件。 */
export function parseStoredObject(
  value: string | null,
  ref: StoredJsonRef,
): Record<string, unknown> | null {
  const parsed = parseStoredJson(value, ref);
  if (parsed === null) return null;
  if (!isStoredObject(parsed)) throw corrupted(ref, "不是 JSON 物件");
  return parsed;
}

export interface StoredToolResultRef {
  tool: string;
  key: string;
}

function corruptedReplay(ref: StoredToolResultRef, reason: string): SmileworkError {
  return new SmileworkError(
    ERROR_CODES.internal,
    `冪等鍵 ${ref.key} 的快取回放內容損壞：${reason}（工具 ${ref.tool}）。`,
    "回報這個問題，並附上冪等鍵、工具名稱與資料庫路徑。",
    { key: ref.key, tool: ref.tool },
  );
}

/** 驗證冪等鍵快取的工具結果外框；缺 summary、data 或 nextAction 的半成品不能當成成功或失敗回放。 */
export function parseStoredToolResult(response: string, ref: StoredToolResultRef): ToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw corruptedReplay(ref, "不是合法 JSON");
  }
  if (!isStoredObject(parsed)) throw corruptedReplay(ref, "不是工具結果物件");

  if (parsed.ok === true) {
    if (typeof parsed.summary !== "string" || !isStoredObject(parsed.data)) {
      throw corruptedReplay(ref, "成功結果缺少 summary 或 data");
    }
    return parsed as unknown as ToolResult;
  }
  if (parsed.ok === false) {
    if (typeof parsed.code !== "string" || typeof parsed.message !== "string") {
      throw corruptedReplay(ref, "失敗結果缺少 code 或 message");
    }
    const missing: string[] = [];
    if (typeof parsed.nextAction !== "string") missing.push("nextAction");
    if (!isStoredObject(parsed.data)) missing.push("data");
    if (missing.length > 0) {
      throw corruptedReplay(ref, `失敗結果缺少 ${missing.join("、")}`);
    }
    return parsed as unknown as ToolResult;
  }
  throw corruptedReplay(ref, "缺少 ok 布林值");
}
