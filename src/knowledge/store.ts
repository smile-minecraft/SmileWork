/**
 * 知識項目儲存：entry 與版本鏈都寫進 SQLite，版本內容以 digest 定址存成
 * knowledge-store 下的快照。讀取會記錄 usage event，讀取次數由事件計算。
 */

import type { Database } from "bun:sqlite";
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLayer,
  KnowledgeStatus,
  KnowledgeType,
  KnowledgeVersion,
} from "../domain/knowledge.ts";
import { withImmediateTransaction } from "../db/transaction.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { newId } from "../shared/hash.ts";
import { nowIso } from "../shared/time.ts";
import {
  KNOWLEDGE_ERROR_CODES,
  appendKnowledgeVersion,
  assertKnowledgeEntryVersion,
  insertKnowledgeVersion,
  readKnowledgeEntryRow,
  readKnowledgeSnapshot,
  requireKnowledgeEntry,
  requireKnowledgeVersion,
  rowToKnowledgeEntry,
  type KnowledgeEntryRow,
  type KnowledgeStoreOptions,
} from "./versions.ts";

export interface CreateKnowledgeEntryInput {
  knowledgeId: string;
  layer: KnowledgeLayer;
  /** project 層必填；global 層必須省略或給 null。 */
  projectId?: string | null;
  kind: KnowledgeKind;
  type: KnowledgeType;
  title: string;
  description?: string;
  pinned?: boolean;
  source?: string;
  tags?: readonly string[];
  /** 適用的專案內相對路徑 glob。 */
  scopePaths?: readonly string[];
  status?: KnowledgeStatus;
  workId?: string | null;
  /** UTF-8 Markdown 內容，建立時同步產生第一版。 */
  content: string;
  actor: string;
  actorModel?: string | null;
  reason?: string | null;
  sourceSignalIds?: readonly string[];
}

export interface UpdateKnowledgeEntryInput {
  /** 新的 UTF-8 Markdown 內容；每次更新都產生新版本。 */
  content: string;
  actor: string;
  actorModel?: string | null;
  reason?: string | null;
  sourceSignalIds?: readonly string[];
  /** entry 列的樂觀鎖版本；有給就必須與目前相符。 */
  expectedVersion?: number;
  title?: string;
  description?: string;
  pinned?: boolean;
  source?: string;
  tags?: readonly string[];
  scopePaths?: readonly string[];
  status?: KnowledgeStatus;
  workId?: string | null;
}

export interface SetKnowledgeEntryStatusInput {
  status: KnowledgeStatus;
  actor: string;
  actorModel?: string | null;
  expectedVersion?: number;
}

export interface ReadKnowledgeOptions extends KnowledgeStoreOptions {
  /** 未指定時讀 currentVersion。 */
  version?: number;
  /** 預設 true；設 false 可讀取內容但不記 usage event。 */
  recordUsage?: boolean;
  action?: string;
  actor?: string;
  actorModel?: string | null;
  query?: string | null;
}

export interface KnowledgeEntryContent {
  entry: KnowledgeEntry;
  version: KnowledgeVersion;
  content: string;
}

export interface RecordKnowledgeUsageInput {
  knowledgeId: string;
  projectId?: string | null;
  layer?: KnowledgeLayer | null;
  version?: number | null;
  action?: string;
  actor: string;
  actorModel?: string | null;
  query?: string | null;
  details?: Record<string, unknown> | null;
}

export interface KnowledgeUsageStats {
  readCount: number;
  lastReadAt: string | null;
}

function normalizeStrings(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function assertLayerScope(layer: KnowledgeLayer, projectId: string | null | undefined): void {
  if (layer === "project" && !projectId) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      "project 層的知識項目必須指定 projectId。",
      "提供已登記的專案 ID，或改用 global 層。",
      { field: "projectId" },
    );
  }
  if (layer === "global" && projectId) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      "global 層的知識項目不能指定 projectId。",
      "移除 projectId，或把 layer 改成 project。",
      { field: "projectId" },
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

/** 建立知識項目與第一版內容。 */
export function createKnowledgeEntry(
  db: Database,
  input: CreateKnowledgeEntryInput,
  options: KnowledgeStoreOptions = {},
): KnowledgeEntry {
  assertLayerScope(input.layer, input.projectId);
  const projectId = input.layer === "project" ? (input.projectId ?? null) : null;
  let entryId: number;

  try {
    entryId = withImmediateTransaction(db, () => {
      const now = nowIso();
      const result = db.query(
        `INSERT INTO knowledge_entries (
           knowledge_id, layer, project_id, kind, type, title, description,
           pinned, source, tags, scope_paths, status, current_version, version, work_id,
           created_at, updated_at, created_by, created_by_model,
           updated_by, updated_by_model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.knowledgeId,
        input.layer,
        projectId,
        input.kind,
        input.type,
        input.title,
        input.description ?? "",
        input.pinned ? 1 : 0,
        input.source ?? "manual",
        JSON.stringify(normalizeStrings(input.tags)),
        JSON.stringify(normalizeStrings(input.scopePaths)),
        input.status ?? "active",
        input.workId ?? null,
        now,
        now,
        input.actor,
        input.actorModel ?? null,
        input.actor,
        input.actorModel ?? null,
      );
      const id = Number(result.lastInsertRowid);
      insertKnowledgeVersion(
        db,
        {
          entryId: id,
          version: 1,
          content: input.content,
          actor: input.actor,
          actorModel: input.actorModel,
          reason: input.reason,
          sourceSignalIds: input.sourceSignalIds,
          workId: input.workId ?? null,
        },
        options,
      );
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SmileworkError(
        KNOWLEDGE_ERROR_CODES.alreadyExists,
        `知識項目已經存在：${input.knowledgeId}（${input.layer}）`,
        "先讀取既有項目，或換一個 knowledgeId。",
        { knowledgeId: input.knowledgeId, layer: input.layer, projectId },
      );
    }
    throw error;
  }

  return requireKnowledgeEntry(db, entryId);
}

/** 更新 entry 的內容與可選的 metadata，每次都追加一個版本。 */
export function updateKnowledgeEntry(
  db: Database,
  entryId: number,
  input: UpdateKnowledgeEntryInput,
  options: KnowledgeStoreOptions = {},
): KnowledgeEntry {
  return withImmediateTransaction(db, () => {
    const entry = requireKnowledgeEntry(db, entryId);
    assertKnowledgeEntryVersion(entry, input.expectedVersion);

    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.title !== undefined) {
      columns.push("title = ?");
      values.push(input.title);
    }
    if (input.description !== undefined) {
      columns.push("description = ?");
      values.push(input.description);
    }
    if (input.pinned !== undefined) {
      columns.push("pinned = ?");
      values.push(input.pinned ? 1 : 0);
    }
    if (input.source !== undefined) {
      columns.push("source = ?");
      values.push(input.source);
    }
    if (input.tags !== undefined) {
      columns.push("tags = ?");
      values.push(JSON.stringify(normalizeStrings(input.tags)));
    }
    if (input.scopePaths !== undefined) {
      columns.push("scope_paths = ?");
      values.push(JSON.stringify(normalizeStrings(input.scopePaths)));
    }
    if (input.status !== undefined) {
      columns.push("status = ?");
      values.push(input.status);
    }
    if (input.workId !== undefined) {
      columns.push("work_id = ?");
      values.push(input.workId);
    }
    if (columns.length > 0) {
      db.query(`UPDATE knowledge_entries SET ${columns.join(", ")} WHERE id = ?`).run(
        ...values,
        entryId,
      );
    }

    return appendKnowledgeVersion(
      db,
      {
        entryId,
        content: input.content,
        actor: input.actor,
        actorModel: input.actorModel,
        reason: input.reason,
        sourceSignalIds: input.sourceSignalIds,
        workId: input.workId !== undefined ? input.workId : entry.workId,
      },
      options,
    ).entry;
  });
}

/** 只改狀態（例如退役）；不新增內容版本，但推進 entry 列的樂觀鎖版本。 */
export function setKnowledgeEntryStatus(
  db: Database,
  entryId: number,
  input: SetKnowledgeEntryStatusInput,
): KnowledgeEntry {
  return withImmediateTransaction(db, () => {
    const entry = requireKnowledgeEntry(db, entryId);
    assertKnowledgeEntryVersion(entry, input.expectedVersion);
    db.query(
      `UPDATE knowledge_entries
       SET status = ?, version = version + 1, updated_at = ?,
           updated_by = ?, updated_by_model = ?
       WHERE id = ?`,
    ).run(input.status, nowIso(), input.actor, input.actorModel ?? null, entryId);
    return requireKnowledgeEntry(db, entryId);
  });
}

export function getKnowledgeEntry(db: Database, entryId: number): KnowledgeEntry | null {
  return readKnowledgeEntryRow(db, entryId);
}

/** 用 knowledgeId、layer 與 project 找唯一項目；找不到回 null。 */
export function findKnowledgeEntry(
  db: Database,
  knowledgeId: string,
  layer: KnowledgeLayer,
  projectId: string | null = null,
): KnowledgeEntry | null {
  const row = db
    .query<KnowledgeEntryRow, [string, string, string | null]>(
      `SELECT * FROM knowledge_entries
       WHERE knowledge_id = ? AND layer = ?
         AND COALESCE(project_id, '') = COALESCE(?, '')`,
    )
    .get(knowledgeId, layer, projectId);
  return row ? rowToKnowledgeEntry(row) : null;
}

/** 讀取指定版本，預設記一筆 usage event。 */
export function readKnowledgeVersion(
  db: Database,
  entryId: number,
  version: number,
  options: ReadKnowledgeOptions = {},
): KnowledgeEntryContent {
  const entry = requireKnowledgeEntry(db, entryId);
  const record = requireKnowledgeVersion(db, entry.id, version);
  const content = readKnowledgeSnapshot(record.snapshotPath, record.sha256, options);

  if (options.recordUsage !== false) {
    recordKnowledgeUsage(db, {
      knowledgeId: entry.knowledgeId,
      projectId: entry.projectId,
      layer: entry.layer,
      version: record.version,
      action: options.action ?? "read",
      actor: options.actor ?? "unknown",
      actorModel: options.actorModel ?? null,
      query: options.query ?? null,
    });
  }

  return { entry, version: record, content };
}

/** 讀取目前版本或指定版本，並記錄使用事件。 */
export function readKnowledgeEntry(
  db: Database,
  entryId: number,
  options: ReadKnowledgeOptions = {},
): KnowledgeEntryContent {
  const entry = requireKnowledgeEntry(db, entryId);
  return readKnowledgeVersion(db, entry.id, options.version ?? entry.currentVersion, options);
}

/** 寫入一筆 usage event，回傳新的事件 ID。 */
export function recordKnowledgeUsage(db: Database, input: RecordKnowledgeUsageInput): string {
  const usageId = newId("usage");
  db.query(
    `INSERT INTO usage_events (
       usage_id, project_id, layer, knowledge_id, version, action, actor,
       actor_model, query, details, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    usageId,
    input.projectId ?? null,
    input.layer ?? null,
    input.knowledgeId,
    input.version ?? null,
    input.action ?? "read",
    input.actor,
    input.actorModel ?? null,
    input.query ?? null,
    input.details ? JSON.stringify(input.details) : null,
    nowIso(),
  );
  return usageId;
}

/** 由 usage event 計算某個知識項目的讀取次數與最後讀取時間。 */
export function getKnowledgeUsageStats(db: Database, entryId: number): KnowledgeUsageStats {
  const entry = requireKnowledgeEntry(db, entryId);
  const row = db
    .query<{ read_count: number; last_read_at: string | null }, [string, string, string | null]>(
      `SELECT COUNT(*) AS read_count, MAX(created_at) AS last_read_at
       FROM usage_events
       WHERE knowledge_id = ? AND layer = ?
         AND COALESCE(project_id, '') = COALESCE(?, '')
         AND action = 'read'`,
    )
    .get(entry.knowledgeId, entry.layer, entry.projectId);
  return { readCount: row?.read_count ?? 0, lastReadAt: row?.last_read_at ?? null };
}

export {
  KNOWLEDGE_ERROR_CODES,
  appendKnowledgeVersion,
  assertKnowledgeEntryVersion,
  diffKnowledgeVersions,
  getKnowledgeVersion,
  listKnowledgeVersions,
  readKnowledgeSnapshot,
  requireKnowledgeEntry,
  requireKnowledgeVersion,
  restoreKnowledgeVersion,
  writeKnowledgeSnapshot,
} from "./versions.ts";
export type {
  AppendKnowledgeVersionInput,
  InsertKnowledgeVersionInput,
  KnowledgeEntryRow,
  KnowledgeStoreOptions,
  KnowledgeVersionDiff,
  KnowledgeVersionWriteResult,
  RestoreKnowledgeVersionInput,
  SnapshotLocation,
} from "./versions.ts";
