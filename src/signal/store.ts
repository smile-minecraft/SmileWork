import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "../db/transaction.ts";
import type { Actor } from "../domain/actor.ts";
import type {
  Signal,
  SignalKind,
  SignalScope,
  SignalStatus,
} from "../domain/signal.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { newId, sha256Hex } from "../shared/hash.ts";
import { nowIso } from "../shared/time.ts";
import { SIGNAL_ERROR_CODES } from "./errors.ts";

const NOTE_TOOL = "signal_note";

/**
 * signals 資料表的 status CHECK 仍只接受舊名稱；對外一律使用 domain 的新名稱。
 * 舊資料的 open 與 triaged 都代表還沒被消費，讀取時轉成 new。
 */
const STORED_STATUS_BY_SIGNAL_STATUS: Readonly<Record<SignalStatus, string>> = {
  new: "open",
  consumed: "accepted",
  dismissed: "dismissed",
};

const STORED_STATUSES_BY_SIGNAL_STATUS: Readonly<Record<SignalStatus, readonly string[]>> = {
  new: ["open", "triaged", "new"],
  consumed: ["accepted", "consumed"],
  dismissed: ["dismissed"],
};

const SIGNAL_STATUS_BY_STORED_STATUS: Readonly<Record<string, SignalStatus>> = {
  new: "new",
  open: "new",
  triaged: "new",
  consumed: "consumed",
  accepted: "consumed",
  dismissed: "dismissed",
};

/** kind 沒有資料庫 CHECK；為了不改變既有匯出與匯入對舊值的解讀，仍以舊名稱儲存。 */
const STORED_KIND_BY_SIGNAL_KIND: Readonly<Record<SignalKind, string>> = {
  correction: "correction",
  failure: "failure",
  fix: "fix",
  "review-reject": "review_reject",
  lesson: "lesson",
  other: "decision",
};

const STORED_KINDS_BY_SIGNAL_KIND: Readonly<Record<SignalKind, readonly string[]>> = {
  correction: ["correction"],
  failure: ["failure"],
  fix: ["fix"],
  "review-reject": ["review-reject", "review_reject"],
  lesson: ["lesson"],
  other: ["other", "decision"],
};

const SIGNAL_KIND_BY_STORED_KIND: Readonly<Record<string, SignalKind>> = {
  correction: "correction",
  failure: "failure",
  fix: "fix",
  "review-reject": "review-reject",
  review_reject: "review-reject",
  lesson: "lesson",
  other: "other",
  decision: "other",
};

interface SignalRow {
  signal_id: string;
  project_id: string | null;
  scope: string;
  kind: string;
  content: string;
  status: string;
  work_id: string | null;
  refs: string;
  result_refs: string;
  reason: string | null;
  actor: string;
  actor_model: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface IdempotencyRow {
  request_hash: string;
  response: string;
}

export interface CreateSignalRecord {
  projectId: string | null;
  scope: SignalScope;
  kind: SignalKind;
  content: string;
  workId: string | null;
  refs: readonly string[];
  idempotencyKey: string | null;
  actor: Actor;
}

export interface CreateSignalResult {
  signal: Signal;
  idempotentReplay: boolean;
}

export interface ListSignalsQuery {
  projectId: string | null;
  scope: "project" | "global" | "all";
  status?: SignalStatus;
  kind?: SignalKind;
  since?: string;
  limit: number;
  offset: number;
}

export interface ListSignalsResult {
  signals: Signal[];
  total: number;
  hasMore: boolean;
}

export interface MarkSignalsRecord {
  ids: readonly string[];
  status: SignalStatus;
  reason?: string;
  resultRefs?: readonly string[];
  actor: Actor;
}

function parseStringArray(value: string, signalId: string, field: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // 落到下方的固定錯誤，不吞掉資料損壞的線索。
  }
  throw new SmileworkError(
    ERROR_CODES.internal,
    `訊號 ${signalId} 的 ${field} 不是合法的字串陣列。`,
    "回報這個問題，並附上訊號識別碼與資料庫路徑。",
    { signalId, field },
  );
}

function storedStatus(status: SignalStatus): string {
  return STORED_STATUS_BY_SIGNAL_STATUS[status];
}

function storedKind(kind: SignalKind): string {
  return STORED_KIND_BY_SIGNAL_KIND[kind];
}

function externalStatus(value: string, signalId: string): SignalStatus {
  const status = SIGNAL_STATUS_BY_STORED_STATUS[value];
  if (status !== undefined) return status;
  throw new SmileworkError(
    ERROR_CODES.internal,
    `訊號 ${signalId} 的 status 不是可辨識的值：${value}`,
    "回報這個問題，並附上訊號識別碼與資料庫路徑。",
    { signalId, status: value },
  );
}

function externalKind(value: string, signalId: string): SignalKind {
  const kind = SIGNAL_KIND_BY_STORED_KIND[value];
  if (kind !== undefined) return kind;
  throw new SmileworkError(
    ERROR_CODES.internal,
    `訊號 ${signalId} 的 kind 不是可辨識的值：${value}`,
    "回報這個問題，並附上訊號識別碼與資料庫路徑。",
    { signalId, kind: value },
  );
}

function rowToSignal(row: SignalRow): Signal {
  return {
    signalId: row.signal_id,
    projectId: row.project_id,
    scope: row.scope as SignalScope,
    kind: externalKind(row.kind, row.signal_id),
    content: row.content,
    status: externalStatus(row.status, row.signal_id),
    workId: row.work_id,
    refs: parseStringArray(row.refs, row.signal_id, "refs"),
    resultRefs: parseStringArray(row.result_refs, row.signal_id, "result_refs"),
    reason: row.reason,
    actor: row.actor,
    actorModel: row.actor_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function noteRequestHash(record: CreateSignalRecord): string {
  return sha256Hex(
    JSON.stringify({
      scope: record.scope,
      kind: record.kind,
      content: record.content,
      workId: record.workId,
      refs: record.refs,
    }),
  );
}

function parseStoredSignal(response: string, key: string): Signal {
  try {
    return JSON.parse(response) as Signal;
  } catch {
    throw new SmileworkError(
      ERROR_CODES.internal,
      `冪等鍵 ${key} 儲存的回應不是合法 JSON。`,
      "回報這個問題，並附上冪等鍵與資料庫路徑。",
      { key },
    );
  }
}

/**
 * 建立訊號。同一個 idempotencyKey 重送時回傳原本的訊號；
 * 同一個鍵搭配不同內容時拒絕，避免把兩次不同的記錄誤認成一次。
 */
export function createSignal(db: Database, record: CreateSignalRecord): CreateSignalResult {
  const now = nowIso();
  const projectKey = record.projectId ?? "";
  const idempotencyKey = record.idempotencyKey;
  const requestHash = idempotencyKey === null ? null : noteRequestHash(record);

  return withImmediateTransaction(db, () => {
    if (idempotencyKey !== null && requestHash !== null) {
      const existing = db
        .query<IdempotencyRow, [string, string, string]>(
          `SELECT request_hash, response FROM idempotency_keys
           WHERE project_id = ? AND tool = ? AND key = ?`,
        )
        .get(projectKey, NOTE_TOOL, idempotencyKey);

      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new SmileworkError(
            SIGNAL_ERROR_CODES.idempotencyConflict,
            `冪等鍵 ${idempotencyKey} 已經用在不同內容的訊號。`,
            "換一個 idempotencyKey，或沿用原本的內容重送。",
            { key: idempotencyKey },
          );
        }
        return {
          signal: parseStoredSignal(existing.response, idempotencyKey),
          idempotentReplay: true,
        };
      }
    }

    const signal: Signal = {
      signalId: newId("sig"),
      projectId: record.projectId,
      scope: record.scope,
      kind: record.kind,
      content: record.content,
      status: "new",
      workId: record.workId,
      refs: [...record.refs],
      resultRefs: [],
      reason: null,
      actor: record.actor.name,
      actorModel: record.actor.model,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
    };

    db.query(
      `INSERT INTO signals (
         signal_id, project_id, scope, kind, content, status, work_id,
         refs, result_refs, reason, actor, actor_model, created_at, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      signal.signalId,
      signal.projectId,
      signal.scope,
      storedKind(signal.kind),
      signal.content,
      storedStatus(signal.status),
      signal.workId,
      JSON.stringify(signal.refs),
      JSON.stringify(signal.resultRefs),
      signal.reason,
      signal.actor,
      signal.actorModel,
      signal.createdAt,
      signal.updatedAt,
      signal.updatedBy,
    );

    if (idempotencyKey !== null && requestHash !== null) {
      db.query(
        `INSERT INTO idempotency_keys (project_id, tool, key, request_hash, response, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        projectKey,
        NOTE_TOOL,
        idempotencyKey,
        requestHash,
        JSON.stringify(signal),
        now,
      );
    }

    return { signal, idempotentReplay: false };
  });
}

/** 依範圍、狀態、種類與時間列出訊號；排序固定為建立時間新到舊。 */
export function listSignals(db: Database, query: ListSignalsQuery): ListSignalsResult {
  if (query.scope !== "global" && query.projectId === null) {
    throw new SmileworkError(
      ERROR_CODES.internal,
      "列出專案訊號時缺少專案識別碼。",
      "回報這個問題；工具應該先解析專案再查詢。",
      { scope: query.scope },
    );
  }

  const projectId = query.projectId ?? "";
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (query.scope === "project") {
    conditions.push("project_id = ?");
    params.push(projectId);
  } else if (query.scope === "global") {
    conditions.push("project_id IS NULL");
  } else {
    conditions.push("(project_id = ? OR project_id IS NULL)");
    params.push(projectId);
  }

  if (query.status !== undefined) {
    const statuses = STORED_STATUSES_BY_SIGNAL_STATUS[query.status];
    conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (query.kind !== undefined) {
    const kinds = STORED_KINDS_BY_SIGNAL_KIND[query.kind];
    conditions.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (query.since !== undefined) {
    conditions.push("created_at >= ?");
    params.push(query.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total =
    db
      .query<{ count: number }, Array<string | number>>(
        `SELECT COUNT(*) AS count FROM signals ${where}`,
      )
      .get(...params)?.count ?? 0;

  const rows = db
    .query<SignalRow, Array<string | number>>(
      `SELECT * FROM signals ${where}
       ORDER BY created_at DESC, signal_id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset);

  return {
    signals: rows.map(rowToSignal),
    total,
    hasMore: query.offset + rows.length < total,
  };
}

/**
 * 標記訊號狀態。只更新 status、reason、result_refs、updated_at 與 updated_by；
 * content 與 created_at 保持原值。任何一個 id 不存在就整批不更新。
 */
export function markSignals(db: Database, record: MarkSignalsRecord): Signal[] {
  const ids = [...new Set(record.ids)];
  const placeholders = ids.map(() => "?").join(", ");
  const now = nowIso();

  return withImmediateTransaction(db, () => {
    const rows = db
      .query<SignalRow, string[]>(`SELECT * FROM signals WHERE signal_id IN (${placeholders})`)
      .all(...ids);
    const found = new Set(rows.map((row) => row.signal_id));
    const missingIds = ids.filter((id) => !found.has(id));

    if (missingIds.length > 0) {
      throw new SmileworkError(
        SIGNAL_ERROR_CODES.signalNotFound,
        `找不到訊號：${missingIds.join("、")}`,
        "先用 signal_list 取得正確的訊號識別碼，再重新標記。",
        { missingIds },
      );
    }

    const update = db.query(
      `UPDATE signals
       SET status = ?, reason = ?, result_refs = ?, updated_at = ?, updated_by = ?
       WHERE signal_id = ?`,
    );

    for (const row of rows) {
      const reason = record.reason !== undefined ? record.reason : row.reason;
      const resultRefs =
        record.resultRefs !== undefined
          ? [...record.resultRefs]
          : parseStringArray(row.result_refs, row.signal_id, "result_refs");

      update.run(
        storedStatus(record.status),
        reason,
        JSON.stringify(resultRefs),
        now,
        record.actor.name,
        row.signal_id,
      );
    }

    const updatedRows = db
      .query<SignalRow, string[]>(`SELECT * FROM signals WHERE signal_id IN (${placeholders})`)
      .all(...ids);
    const byId = new Map(updatedRows.map((row) => [row.signal_id, rowToSignal(row)]));

    return ids
      .map((id) => byId.get(id))
      .filter((signal): signal is Signal => signal !== undefined);
  });
}
