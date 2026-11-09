/**
 * 知識版本：內容快照以 SHA-256 digest 定址存在 knowledge-store，
 * SQLite 只記版本鏈與快照的相對路徑。相同內容重複寫入會共用同一份快照。
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLayer,
  KnowledgeStatus,
  KnowledgeType,
  KnowledgeVersion,
} from "../domain/knowledge.ts";
import { withImmediateTransaction } from "../db/transaction.ts";
import { atomicWriteFile } from "../shared/atomic-write.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { sha256Hex } from "../shared/hash.ts";
import { expandHome, smileworkKnowledgeStorePath } from "../shared/paths.ts";
import { parseStoredStringArray } from "../shared/stored-json.ts";
import { nowIso } from "../shared/time.ts";
import { createUnifiedDiff } from "./diff.ts";

export const KNOWLEDGE_ERROR_CODES = {
  entryNotFound: "KNOWLEDGE_ENTRY_NOT_FOUND",
  versionNotFound: "KNOWLEDGE_VERSION_NOT_FOUND",
  alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
  snapshotMissing: "KNOWLEDGE_SNAPSHOT_MISSING",
  snapshotCorrupted: "KNOWLEDGE_SNAPSHOT_CORRUPTED",
} as const;

export interface KnowledgeStoreOptions {
  /** 快照根目錄；預設 SMILEWORK_HOME/knowledge-store。 */
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SnapshotLocation {
  sha256: string;
  bytes: number;
  /** 相對於快照根目錄的路徑，寫進 knowledge_versions.snapshot_path。 */
  snapshotPath: string;
}

export interface KnowledgeEntryRow {
  id: number;
  knowledge_id: string;
  layer: string;
  project_id: string | null;
  kind: string;
  type: string;
  title: string;
  description: string;
  pinned: number;
  source: string;
  tags: string;
  status: string;
  current_version: number;
  version: number;
  work_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  created_by_model: string | null;
  updated_by: string;
  updated_by_model: string | null;
}

interface KnowledgeVersionRow {
  entry_id: number;
  version: number;
  sha256: string;
  bytes: number;
  snapshot_path: string;
  actor: string;
  actor_model: string | null;
  reason: string | null;
  source_signal_ids: string;
  work_id: string | null;
  created_at: string;
}

export function rowToKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    layer: row.layer as KnowledgeLayer,
    projectId: row.project_id,
    kind: row.kind as KnowledgeKind,
    type: row.type as KnowledgeType,
    title: row.title,
    description: row.description,
    pinned: row.pinned === 1,
    source: row.source,
    tags: parseStoredStringArray(row.tags, {
      entity: "知識項目",
      id: row.knowledge_id,
      field: "tags",
    }),
    status: row.status as KnowledgeStatus,
    currentVersion: row.current_version,
    version: row.version,
    workId: row.work_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function rowToKnowledgeVersion(row: KnowledgeVersionRow): KnowledgeVersion {
  return {
    entryId: row.entry_id,
    version: row.version,
    sha256: row.sha256,
    bytes: row.bytes,
    snapshotPath: row.snapshot_path,
    actor: row.actor,
    actorModel: row.actor_model,
    reason: row.reason,
    sourceSignalIds: parseStoredStringArray(row.source_signal_ids, {
      entity: "知識版本",
      id: `${row.entry_id} 版 ${row.version}`,
      field: "source_signal_ids",
    }),
    workId: row.work_id,
    createdAt: row.created_at,
  };
}

export function readKnowledgeEntryRow(db: Database, entryId: number): KnowledgeEntry | null {
  const row = db
    .query<KnowledgeEntryRow, [number]>("SELECT * FROM knowledge_entries WHERE id = ?")
    .get(entryId);
  return row ? rowToKnowledgeEntry(row) : null;
}

export function requireKnowledgeEntry(db: Database, entryId: number): KnowledgeEntry {
  const entry = readKnowledgeEntryRow(db, entryId);
  if (!entry) {
    throw new SmileworkError(
      KNOWLEDGE_ERROR_CODES.entryNotFound,
      `找不到知識項目：${entryId}`,
      "確認知識項目 ID，或先用搜尋找到正確的項目。",
      { entryId },
    );
  }
  return entry;
}

function storeRoot(options: KnowledgeStoreOptions = {}): string {
  if (options.storeRoot) return resolve(expandHome(options.storeRoot));
  return smileworkKnowledgeStorePath(options.env ?? process.env);
}

/** 把資料庫內的相對快照路徑解析成絕對路徑，並拒絕跳脫儲存目錄的路徑。 */
export function resolveKnowledgeSnapshotPath(
  snapshotPath: string,
  options: KnowledgeStoreOptions = {},
): string {
  const root = storeRoot(options);
  const absolute = resolve(root, snapshotPath);
  const inside = relative(root, absolute);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new SmileworkError(
      KNOWLEDGE_ERROR_CODES.snapshotCorrupted,
      `知識快照路徑不在儲存目錄內：${snapshotPath}`,
      "檢查資料庫的 snapshot_path，必要時從備份還原。",
      { snapshotPath, storeRoot: root },
    );
  }
  return absolute;
}

/** 寫入內容快照；路徑由 digest 決定，已存在就不重寫。 */
export function writeKnowledgeSnapshot(
  content: string,
  options: KnowledgeStoreOptions = {},
): SnapshotLocation {
  const digest = sha256Hex(content);
  const bytes = Buffer.byteLength(content, "utf8");
  const snapshotPath = `sha256/${digest}.md`;
  const absolute = resolveKnowledgeSnapshotPath(snapshotPath, options);

  if (!existsSync(absolute)) {
    mkdirSync(dirname(absolute), { recursive: true });
    atomicWriteFile(absolute, content);
  }

  return { sha256: digest, bytes, snapshotPath };
}

/** 讀取快照並用預期的 digest 驗證內容沒有被替換。 */
export function readKnowledgeSnapshot(
  snapshotPath: string,
  expectedSha256: string,
  options: KnowledgeStoreOptions = {},
): string {
  const absolute = resolveKnowledgeSnapshotPath(snapshotPath, options);
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SmileworkError(
        KNOWLEDGE_ERROR_CODES.snapshotMissing,
        `找不到知識快照檔：${snapshotPath}`,
        "確認 knowledge-store 目錄完整，必要時從備份還原。",
        { snapshotPath },
      );
    }
    throw error;
  }

  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new SmileworkError(
      KNOWLEDGE_ERROR_CODES.snapshotCorrupted,
      `知識快照 digest 不符：${snapshotPath}`,
      "內容檔案已被改動或損毀，請從備份還原後再讀取。",
      { snapshotPath, expectedSha256, actualSha256 },
    );
  }
  return bytes.toString("utf8");
}

export function getKnowledgeVersion(
  db: Database,
  entryId: number,
  version: number,
): KnowledgeVersion | null {
  const row = db
    .query<KnowledgeVersionRow, [number, number]>(
      "SELECT * FROM knowledge_versions WHERE entry_id = ? AND version = ?",
    )
    .get(entryId, version);
  return row ? rowToKnowledgeVersion(row) : null;
}

export function requireKnowledgeVersion(
  db: Database,
  entryId: number,
  version: number,
): KnowledgeVersion {
  const found = getKnowledgeVersion(db, entryId, version);
  if (!found) {
    throw new SmileworkError(
      KNOWLEDGE_ERROR_CODES.versionNotFound,
      `找不到知識版本：entry ${entryId} 的版本 ${version}`,
      "用版本歷史確認可用的版本編號後再讀取。",
      { entryId, version },
    );
  }
  return found;
}

export function listKnowledgeVersions(db: Database, entryId: number): KnowledgeVersion[] {
  return db
    .query<KnowledgeVersionRow, [number]>(
      "SELECT * FROM knowledge_versions WHERE entry_id = ? ORDER BY version",
    )
    .all(entryId)
    .map(rowToKnowledgeVersion);
}

export function assertKnowledgeEntryVersion(
  entry: KnowledgeEntry,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion === undefined || entry.version === expectedVersion) return;
  throw new SmileworkError(
    ERROR_CODES.versionConflict,
    `知識項目版本不符：預期 ${expectedVersion}，目前 ${entry.version}`,
    "重新讀取目前的知識項目後再寫入。",
    { entryId: entry.id, expectedVersion, actualVersion: entry.version },
  );
}

export interface InsertKnowledgeVersionInput {
  entryId: number;
  version: number;
  content: string;
  actor: string;
  actorModel?: string | null;
  reason?: string | null;
  sourceSignalIds?: readonly string[];
  workId?: string | null;
}

/** 寫入一筆版本與它的內容快照；不推進 entry 的 current_version。 */
export function insertKnowledgeVersion(
  db: Database,
  input: InsertKnowledgeVersionInput,
  options: KnowledgeStoreOptions = {},
): KnowledgeVersion {
  const snapshot = writeKnowledgeSnapshot(input.content, options);
  db.query(
    `INSERT INTO knowledge_versions (
       entry_id, version, sha256, bytes, snapshot_path, actor, actor_model,
       reason, source_signal_ids, work_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.entryId,
    input.version,
    snapshot.sha256,
    snapshot.bytes,
    snapshot.snapshotPath,
    input.actor,
    input.actorModel ?? null,
    input.reason ?? null,
    JSON.stringify([...(input.sourceSignalIds ?? [])]),
    input.workId ?? null,
    nowIso(),
  );
  return requireKnowledgeVersion(db, input.entryId, input.version);
}

export interface AppendKnowledgeVersionInput {
  entryId: number;
  content: string;
  actor: string;
  actorModel?: string | null;
  reason?: string | null;
  sourceSignalIds?: readonly string[];
  workId?: string | null;
  expectedVersion?: number;
}

export interface KnowledgeVersionWriteResult {
  entry: KnowledgeEntry;
  version: KnowledgeVersion;
}

/** 在現有版本鏈尾端追加一版，並推進 entry 的內容版本與列版本。 */
export function appendKnowledgeVersion(
  db: Database,
  input: AppendKnowledgeVersionInput,
  options: KnowledgeStoreOptions = {},
): KnowledgeVersionWriteResult {
  return withImmediateTransaction(db, () => {
    const entry = requireKnowledgeEntry(db, input.entryId);
    assertKnowledgeEntryVersion(entry, input.expectedVersion);
    const nextVersion = entry.currentVersion + 1;
    const version = insertKnowledgeVersion(
      db,
      {
        entryId: entry.id,
        version: nextVersion,
        content: input.content,
        actor: input.actor,
        actorModel: input.actorModel,
        reason: input.reason,
        sourceSignalIds: input.sourceSignalIds,
        workId: input.workId !== undefined ? input.workId : entry.workId,
      },
      options,
    );
    db.query(
      `UPDATE knowledge_entries
       SET current_version = ?, version = version + 1, updated_at = ?,
           updated_by = ?, updated_by_model = ?
       WHERE id = ?`,
    ).run(nextVersion, nowIso(), input.actor, input.actorModel ?? null, entry.id);
    return { entry: requireKnowledgeEntry(db, entry.id), version };
  });
}

function previousVersion(
  db: Database,
  entryId: number,
  version: number,
): KnowledgeVersion | null {
  const row = db
    .query<KnowledgeVersionRow, [number, number]>(
      `SELECT * FROM knowledge_versions
       WHERE entry_id = ? AND version < ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(entryId, version);
  return row ? rowToKnowledgeVersion(row) : null;
}

export interface KnowledgeVersionDiff {
  entryId: number;
  version: number;
  previousVersion: number | null;
  diff: string;
}

/** 比較指定版本與它的前一版；第一版會和空內容比較。 */
export function diffKnowledgeVersions(
  db: Database,
  entryId: number,
  version: number,
  options: KnowledgeStoreOptions = {},
): KnowledgeVersionDiff {
  const entry = requireKnowledgeEntry(db, entryId);
  const current = requireKnowledgeVersion(db, entry.id, version);
  const previous = previousVersion(db, entry.id, version);
  const previousContent = previous
    ? readKnowledgeSnapshot(previous.snapshotPath, previous.sha256, options)
    : "";
  const currentContent = readKnowledgeSnapshot(current.snapshotPath, current.sha256, options);

  return {
    entryId: entry.id,
    version: current.version,
    previousVersion: previous?.version ?? null,
    diff: createUnifiedDiff(previousContent, currentContent, {
      oldLabel: previous ? `v${previous.version}` : "empty",
      newLabel: `v${current.version}`,
    }),
  };
}

export interface RestoreKnowledgeVersionInput {
  entryId: number;
  version: number;
  actor: string;
  actorModel?: string | null;
  reason?: string | null;
  expectedVersion?: number;
}

/** 還原到指定版本：建立一個內容相同的新版本，舊版本保持不動。 */
export function restoreKnowledgeVersion(
  db: Database,
  input: RestoreKnowledgeVersionInput,
  options: KnowledgeStoreOptions = {},
): KnowledgeVersionWriteResult {
  return withImmediateTransaction(db, () => {
    const entry = requireKnowledgeEntry(db, input.entryId);
    assertKnowledgeEntryVersion(entry, input.expectedVersion);
    const source = requireKnowledgeVersion(db, entry.id, input.version);
    const content = readKnowledgeSnapshot(source.snapshotPath, source.sha256, options);
    return appendKnowledgeVersion(
      db,
      {
        entryId: entry.id,
        content,
        actor: input.actor,
        actorModel: input.actorModel,
        reason: input.reason ?? `還原至版本 ${source.version}`,
        workId: entry.workId,
      },
      options,
    );
  });
}
