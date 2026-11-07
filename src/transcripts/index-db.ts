import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { withImmediateTransaction } from "../db/transaction.ts";
import { redactSecrets } from "../shared/secrets.ts";
import { nowIso } from "../shared/time.ts";
import type { ParsedEntry, TranscriptSource } from "./types.ts";
import { truncateText } from "./text.ts";

const SCHEMA_VERSION = 1;

export function transcriptIndexExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 建立或開啟索引；初始化順序沿用 spike 的結論：busy_timeout 必須在 WAL 之前。 */
export function openTranscriptIndex(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // 索引含有對話內容，只讓目前使用者讀寫；WAL/SHM 會沿用資料庫檔權限。
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 或唯讀檔案系統不支援 POSIX 權限，不因此中斷索引。
  }
  configureIndexConnection(db);
  ensureTranscriptSchema(db);
  return db;
}

/** 搜尋與讀取只開唯讀連線，不存在時回 null，讓呼叫端決定要不要啟動索引。 */
export function openTranscriptIndexReadonly(path: string): Database | null {
  if (!transcriptIndexExists(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 15000");
    return db;
  } catch {
    return null;
  }
}

function configureIndexConnection(db: Database): void {
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
}

export function ensureTranscriptSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS source_files (
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      session_ref TEXT NOT NULL,
      project_path TEXT,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      offset_bytes INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, path)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      source TEXT NOT NULL,
      session_ref TEXT NOT NULL,
      project_path TEXT,
      last_turn INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, session_ref)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS entries (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      session_ref TEXT NOT NULL,
      project_path TEXT,
      turn INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      tool_name TEXT,
      at TEXT,
      origin TEXT NOT NULL,
      origin_seq INTEGER NOT NULL,
      block_index INTEGER NOT NULL DEFAULT 0,
      UNIQUE (source, session_ref, origin, origin_seq, block_index)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_entries_session
      ON entries(source, session_ref, turn, origin_seq, block_index);
    CREATE INDEX IF NOT EXISTS idx_entries_origin ON entries(source, origin);
    CREATE INDEX IF NOT EXISTS idx_entries_at ON entries(at);

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      text,
      content='entries',
      content_rowid='entry_id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, text) VALUES (new.entry_id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.entry_id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.entry_id, old.text);
      INSERT INTO entries_fts(rowid, text) VALUES (new.entry_id, new.text);
    END;

    CREATE TABLE IF NOT EXISTS warnings (
      source TEXT NOT NULL,
      origin TEXT NOT NULL,
      message TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, origin, message)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS opencode_sessions (
      session_ref TEXT PRIMARY KEY,
      project_path TEXT,
      last_time INTEGER NOT NULL DEFAULT 0,
      last_turn INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS opencode_messages (
      session_ref TEXT NOT NULL,
      message_ref TEXT NOT NULL,
      turn INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      PRIMARY KEY (session_ref, message_ref)
    ) STRICT;
  `);

  const version = readSchemaVersion(db);
  if (version === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function readSchemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export interface SourceFileRow {
  readonly source: string;
  readonly path: string;
  readonly session_ref: string;
  readonly project_path: string | null;
  readonly mtime_ms: number;
  readonly size_bytes: number;
  readonly offset_bytes: number;
  readonly state_json: string;
}

export function getSourceFileRow(
  db: Database,
  source: TranscriptSource,
  path: string,
): SourceFileRow | null {
  return db
    .query<SourceFileRow, [string, string]>(
      `SELECT source, path, session_ref, project_path, mtime_ms, size_bytes, offset_bytes, state_json
       FROM source_files WHERE source = ? AND path = ?`,
    )
    .get(source, path);
}

export function listSourceFileRows(db: Database, source: TranscriptSource): SourceFileRow[] {
  return db
    .query<SourceFileRow, [string]>(
      `SELECT source, path, session_ref, project_path, mtime_ms, size_bytes, offset_bytes, state_json
       FROM source_files WHERE source = ?`,
    )
    .all(source);
}

export function upsertSourceFileRow(
  db: Database,
  row: {
    source: TranscriptSource;
    path: string;
    sessionRef: string;
    projectPath: string | null;
    mtimeMs: number;
    sizeBytes: number;
    offsetBytes: number;
    stateJson: string;
  },
): void {
  db.query(
    `INSERT INTO source_files
       (source, path, session_ref, project_path, mtime_ms, size_bytes, offset_bytes, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, path) DO UPDATE SET
       session_ref = excluded.session_ref,
       project_path = excluded.project_path,
       mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes,
       offset_bytes = excluded.offset_bytes,
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  ).run(
    row.source,
    row.path,
    row.sessionRef,
    row.projectPath,
    row.mtimeMs,
    row.sizeBytes,
    row.offsetBytes,
    row.stateJson,
    nowIso(),
  );
}

export function deleteSourceFileRow(
  db: Database,
  source: TranscriptSource,
  path: string,
): void {
  db.query("DELETE FROM source_files WHERE source = ? AND path = ?").run(source, path);
}

export function deleteEntriesForOrigin(
  db: Database,
  source: TranscriptSource,
  origin: string,
): void {
  db.query("DELETE FROM entries WHERE source = ? AND origin = ?").run(source, origin);
}

export function deleteEntriesForSession(db: Database, sessionRef: string): void {
  db.query("DELETE FROM entries WHERE session_ref = ?").run(sessionRef);
}

export function upsertSessionRow(
  db: Database,
  source: TranscriptSource,
  sessionRef: string,
  projectPath: string | null,
  lastTurn: number,
): void {
  db.query(
    `INSERT INTO sessions (source, session_ref, project_path, last_turn, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, session_ref) DO UPDATE SET
       project_path = excluded.project_path,
       last_turn = MAX(sessions.last_turn, excluded.last_turn),
       updated_at = excluded.updated_at`,
  ).run(source, sessionRef, projectPath, lastTurn, nowIso());
}

/**
 * 索引前先遮蔽機密，並限制單筆長度。FTS 與 read 都只會看到這裡寫入的內容。
 */
export function insertParsedEntries(
  db: Database,
  params: {
    source: TranscriptSource;
    sessionRef: string;
    projectPath: string | null;
    origin: string;
    entries: readonly ParsedEntry[];
    maxEntryChars: number;
  },
): number {
  if (params.entries.length === 0) return 0;
  const statement = db.query(
    `INSERT INTO entries
       (source, session_ref, project_path, turn, role, text, tool_name, at, origin, origin_seq, block_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, session_ref, origin, origin_seq, block_index) DO UPDATE SET
       turn = excluded.turn,
       role = excluded.role,
       text = excluded.text,
       tool_name = excluded.tool_name,
       at = excluded.at,
       project_path = excluded.project_path`,
  );

  let inserted = 0;
  for (const entry of params.entries) {
    const text = truncateText(redactSecrets(entry.text), params.maxEntryChars);
    if (!text) continue;
    statement.run(
      params.source,
      params.sessionRef,
      params.projectPath,
      entry.turn,
      entry.role,
      text,
      entry.toolName ?? null,
      entry.at ?? null,
      params.origin,
      entry.originSeq,
      entry.blockIndex,
    );
    inserted += 1;
  }
  return inserted;
}

export function recordWarnings(
  db: Database,
  source: TranscriptSource,
  origin: string,
  warnings: ReadonlyMap<string, number>,
): void {
  if (warnings.size === 0) return;
  const statement = db.query(
    `INSERT INTO warnings (source, origin, message, occurrences, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, origin, message) DO UPDATE SET
       occurrences = warnings.occurrences + excluded.occurrences,
       updated_at = excluded.updated_at`,
  );
  const updatedAt = nowIso();
  for (const [message, occurrences] of warnings) {
    statement.run(source, origin, message, occurrences, updatedAt);
  }
}

export function getIndexMeta(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM index_meta WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setIndexMeta(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO index_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function countIndexEntries(db: Database): number {
  const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM entries").get();
  return row?.count ?? 0;
}

export function countIndexSessions(db: Database): number {
  const row = db
    .query<{ count: number }, []>("SELECT COUNT(DISTINCT session_ref) AS count FROM entries")
    .get();
  return row?.count ?? 0;
}

/** 清空所有索引資料（FTS 由 trigger 同步），讓下一次建置從頭來。 */
export function resetTranscriptIndex(db: Database): void {
  withImmediateTransaction(db, () => {
    for (const table of [
      "entries",
      "source_files",
      "sessions",
      "warnings",
      "opencode_sessions",
      "opencode_messages",
      "index_meta",
    ]) {
      db.exec(`DELETE FROM ${table}`);
    }
  });
}
