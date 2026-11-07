import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { withImmediateTransaction } from "../db/transaction.ts";
import { smileworkTranscriptsPath } from "../shared/paths.ts";
import { parseClaudeRecord } from "./adapters/claude.ts";
import { parseCodexRecord } from "./adapters/codex.ts";
import {
  countIndexableOpencodeMessages,
  detectOpencodeSchema,
  listOpencodeMessageIds,
  listOpencodeSessions,
  openOpencodeReadonly,
  readOpencodeChanges,
} from "./adapters/opencode.ts";
import { createLineState, restoreLineState, type LineState } from "./adapters/shared.ts";
import {
  countIndexEntries,
  countIndexSessions,
  deleteEntriesForOrigin,
  deleteEntriesForSession,
  deleteSourceFileRow,
  getSourceFileRow,
  insertParsedEntries,
  listSourceFileRows,
  openTranscriptIndex,
  recordWarnings,
  resetTranscriptIndex,
  setIndexMeta,
  upsertSessionRow,
  upsertSourceFileRow,
} from "./index-db.ts";
import { acquireBuildLock, buildLockPath } from "./lock.ts";
import {
  isProjectExcluded,
  readTranscriptConfig,
  transcriptConfigFingerprint,
  transcriptPaths,
  type TranscriptConfig,
} from "./config.ts";
import type { ParsedEntry, TranscriptSource } from "./types.ts";
import { asRecord } from "./adapters/shared.ts";

const JSONL_SOURCES = ["claude", "codex"] as const;

interface AdapterDefinition {
  readonly parseRecord: (record: Record<string, unknown>, state: LineState) => {
    entries: readonly ParsedEntry[];
    warning?: string;
  };
  readonly createState: (path: string) => LineState;
  readonly restoreState: (path: string, stored: unknown) => LineState;
}

const ADAPTERS: Record<(typeof JSONL_SOURCES)[number], AdapterDefinition> = {
  claude: {
    parseRecord: parseClaudeRecord,
    createState: (path) => createLineState("claude", path),
    restoreState: (path, stored) => restoreLineState("claude", path, stored),
  },
  codex: {
    parseRecord: parseCodexRecord,
    createState: (path) => createLineState("codex", path),
    restoreState: (path, stored) => restoreLineState("codex", path, stored),
  },
};

export interface FileBuildReport {
  readonly source: TranscriptSource;
  readonly path: string;
  readonly parsedLines: number;
  readonly addedEntries: number;
  readonly fromOffset: number;
  readonly toOffset: number;
  readonly reset: boolean;
  readonly skippedReason?: string;
}

export interface WarningReport {
  readonly source: TranscriptSource;
  readonly message: string;
  readonly occurrences: number;
}

export interface BuildReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly skipped: boolean;
  readonly reason: string | null;
  readonly files: readonly FileBuildReport[];
  readonly opencode: {
    readonly sessions: number;
    readonly changedMessages: number;
    readonly addedEntries: number;
  };
  readonly warnings: readonly WarningReport[];
  readonly errors: readonly WarningReport[];
  readonly totals: {
    readonly entries: number;
    readonly sessions: number;
  };
}

export interface BuildOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: TranscriptConfig;
  readonly dbPath?: string;
  readonly lockPath?: string;
  readonly now?: () => Date;
  /** 清空既有索引後重建；仍會走增量解析流程。 */
  readonly rebuild?: boolean;
}

interface WarningCollector {
  add(source: TranscriptSource, message: string, occurrences?: number): void;
  values(): WarningReport[];
}

function createWarningCollector(): WarningCollector {
  const entries = new Map<string, { source: TranscriptSource; message: string; occurrences: number }>();
  return {
    add(source, message, occurrences = 1): void {
      const key = `${source}\u0000${message}`;
      const existing = entries.get(key);
      if (existing) existing.occurrences += occurrences;
      else entries.set(key, { source, message, occurrences });
    },
    values(): WarningReport[] {
      return [...entries.values()].sort((left, right) => {
        if (left.source !== right.source) return left.source.localeCompare(right.source);
        return right.occurrences - left.occurrences;
      });
    },
  };
}

/**
 * 建立或增量更新對話索引。整個流程由檔案鎖保護；拿不到鎖就直接回報
 * skipped，讓搜尋端知道已有另一個程序在建。
 */
export function buildTranscriptIndex(options: BuildOptions = {}): BuildReport {
  const env = options.env ?? process.env;
  const config = options.config ?? readTranscriptConfig(env);
  const dbPath = options.dbPath ?? smileworkTranscriptsPath(env);
  const lockPath = options.lockPath ?? buildLockPath(dbPath);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const startedMs = performance.now();

  const lock = acquireBuildLock(lockPath);
  if (!lock) {
    return {
      startedAt,
      finishedAt: now().toISOString(),
      durationMs: Math.round(performance.now() - startedMs),
      skipped: true,
      reason: "locked",
      files: [],
      opencode: { sessions: 0, changedMessages: 0, addedEntries: 0 },
      warnings: [],
      errors: [],
      totals: { entries: 0, sessions: 0 },
    };
  }

  const files: FileBuildReport[] = [];
  const warnings = createWarningCollector();
  const errors = createWarningCollector();
  const touch = (): void => lock.touch();

  try {
    lock.touch();
    const db = openTranscriptIndex(dbPath);
    try {
      if (options.rebuild) resetTranscriptIndex(db);
      for (const source of JSONL_SOURCES) {
        if (!config.sources[source]) {
          clearJsonlSource(db, source);
          continue;
        }
        const root = transcriptPaths(env)[source === "claude" ? "claudeDir" : "codexDir"];
        collectJsonlFiles(db, source, root, config, files, warnings, errors, touch);
      }

      let opencode = { sessions: 0, changedMessages: 0, addedEntries: 0 };
      if (config.sources.opencode) {
        opencode = indexOpencode(db, env, config, warnings, errors, now, touch);
      } else {
        clearOpencodeSource(db);
      }

      setIndexMeta(db, "last_scan_at", now().toISOString());
      setIndexMeta(db, "last_scan_entries", String(countIndexEntries(db)));
      setIndexMeta(db, "config_key", transcriptConfigFingerprint(config));

      return {
        startedAt,
        finishedAt: now().toISOString(),
        durationMs: Math.round(performance.now() - startedMs),
        skipped: false,
        reason: null,
        files,
        opencode,
        warnings: warnings.values(),
        errors: errors.values(),
        totals: {
          entries: countIndexEntries(db),
          sessions: countIndexSessions(db),
        },
      };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

function clearJsonlSource(db: Database, source: (typeof JSONL_SOURCES)[number]): void {
  withImmediateTransaction(db, () => {
    db.query("DELETE FROM entries WHERE source = ?").run(source);
    db.query("DELETE FROM source_files WHERE source = ?").run(source);
    db.query("DELETE FROM sessions WHERE source = ?").run(source);
    db.query("DELETE FROM warnings WHERE source = ?").run(source);
  });
}

function clearOpencodeSource(db: Database): void {
  withImmediateTransaction(db, () => {
    db.query("DELETE FROM entries WHERE source = 'opencode'").run();
    db.query("DELETE FROM opencode_sessions").run();
    db.query("DELETE FROM opencode_messages").run();
    db.query("DELETE FROM sessions WHERE source = 'opencode'").run();
    db.query("DELETE FROM warnings WHERE source = 'opencode'").run();
  });
}

function collectJsonlFiles(
  db: Database,
  source: (typeof JSONL_SOURCES)[number],
  root: string,
  config: TranscriptConfig,
  files: FileBuildReport[],
  warnings: WarningCollector,
  errors: WarningCollector,
  touch: () => void,
): void {
  if (!existsSync(root)) return;
  const discovered = discoverJsonlFiles(root);
  const seen = new Set(discovered);

  for (const path of discovered) {
    touch();
    try {
      files.push(processJsonlFile(db, source, path, config, warnings));
    } catch (error) {
      errors.add(source, `${path}：${messageOf(error)}`);
    }
  }

  for (const row of listSourceFileRows(db, source)) {
    if (seen.has(row.path)) continue;
    withImmediateTransaction(db, () => {
      deleteEntriesForOrigin(db, source, row.path);
      deleteSourceFileRow(db, source, row.path);
      db.query("DELETE FROM warnings WHERE source = ? AND origin = ?").run(source, row.path);
    });
  }
}

function discoverJsonlFiles(root: string): string[] {
  const output: string[] = [];
  const stack = [resolve(root)];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        output.push(path);
      }
    }
  }
  return output.sort();
}

function processJsonlFile(
  db: Database,
  source: (typeof JSONL_SOURCES)[number],
  path: string,
  config: TranscriptConfig,
  warnings: WarningCollector,
): FileBuildReport {
  const adapter = ADAPTERS[source];
  const stat = statSync(path);
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const prior = getSourceFileRow(db, source, path);
  const priorState = prior
    ? adapter.restoreState(path, parseStateJson(prior.state_json))
    : null;
  const priorProjectPath = priorState?.projectPath ?? prior?.project_path ?? undefined;

  if (priorProjectPath && isProjectExcluded(priorProjectPath, config.excludeProjects)) {
    withImmediateTransaction(db, () => {
      upsertSessionRow(
        db,
        source,
        priorState?.sessionRef ?? prior?.session_ref ?? path,
        priorProjectPath,
        0,
      );
      deleteEntriesForOrigin(db, source, path);
      deleteSourceFileRow(db, source, path);
      db.query("DELETE FROM warnings WHERE source = ? AND origin = ?").run(source, path);
    });
    return {
      source,
      path,
      parsedLines: 0,
      addedEntries: 0,
      fromOffset: prior?.offset_bytes ?? 0,
      toOffset: prior?.offset_bytes ?? 0,
      reset: false,
      skippedReason: "excluded-project",
    };
  }

  const unchanged =
    prior !== null && stat.size === prior.offset_bytes && mtimeMs === prior.mtime_ms;
  if (unchanged) {
    return {
      source,
      path,
      parsedLines: 0,
      addedEntries: 0,
      fromOffset: prior.offset_bytes,
      toOffset: prior.offset_bytes,
      reset: false,
    };
  }

  const reset =
    prior === null ||
    stat.size < prior.offset_bytes ||
    (stat.size === prior.offset_bytes && mtimeMs !== prior.mtime_ms);

  if (stat.size > config.maxFileBytes && (reset || prior === null)) {
    warnings.add(source, `${path}：檔案超過索引上限 ${config.maxFileBytes} bytes，未建立索引`);
    return {
      source,
      path,
      parsedLines: 0,
      addedEntries: 0,
      fromOffset: 0,
      toOffset: 0,
      reset,
      skippedReason: "too-large",
    };
  }

  const offset = reset ? 0 : (prior?.offset_bytes ?? 0);
  const state = reset
    ? adapter.createState(path)
    : adapter.restoreState(path, parseStateJson(prior?.state_json));
  const buffer = readFromOffset(path, offset, stat.size);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return {
      source,
      path,
      parsedLines: 0,
      addedEntries: 0,
      fromOffset: offset,
      toOffset: offset,
      reset,
    };
  }

  const complete = buffer.subarray(0, lastNewline + 1);
  const toOffset = offset + complete.byteLength;
  const lines = complete.toString("utf8").split("\n");
  const entries: ParsedEntry[] = [];
  const fileWarnings = new Map<string, number>();
  let parsedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    parsedLines += 1;
    let record: Record<string, unknown> | null = null;
    try {
      record = asRecord(JSON.parse(trimmed));
    } catch {
      increment(fileWarnings, "不是有效的 JSON 行");
      continue;
    }
    if (!record) {
      increment(fileWarnings, "紀錄不是 JSON 物件");
      continue;
    }
    const result = (() => {
      try {
        return adapter.parseRecord(record, state);
      } catch (error) {
        increment(fileWarnings, `解析失敗：${messageOf(error)}`);
        return null;
      }
    })();
    if (!result) continue;
    if (result.warning) increment(fileWarnings, result.warning);
    entries.push(...result.entries);
  }

  if (state.projectPath && isProjectExcluded(state.projectPath, config.excludeProjects)) {
    withImmediateTransaction(db, () => {
      upsertSessionRow(db, source, state.sessionRef, state.projectPath ?? null, 0);
      deleteEntriesForOrigin(db, source, path);
      deleteSourceFileRow(db, source, path);
      db.query("DELETE FROM warnings WHERE source = ? AND origin = ?").run(source, path);
    });
    return {
      source,
      path,
      parsedLines,
      addedEntries: 0,
      fromOffset: offset,
      toOffset,
      reset,
      skippedReason: "excluded-project",
    };
  }

  let addedEntries = 0;
  withImmediateTransaction(db, () => {
    if (reset) deleteEntriesForOrigin(db, source, path);
    addedEntries = insertParsedEntries(db, {
      source,
      sessionRef: state.sessionRef,
      projectPath: state.projectPath ?? null,
      origin: path,
      entries,
      maxEntryChars: config.maxEntryChars,
    });
    upsertSourceFileRow(db, {
      source,
      path,
      sessionRef: state.sessionRef,
      projectPath: state.projectPath ?? null,
      mtimeMs,
      sizeBytes: stat.size,
      offsetBytes: toOffset,
      stateJson: JSON.stringify(state),
    });
    upsertSessionRow(db, source, state.sessionRef, state.projectPath ?? null, state.turn);
    recordWarnings(db, source, path, fileWarnings);
  });

  for (const [message, occurrences] of fileWarnings) {
    warnings.add(source, message, occurrences);
  }

  return {
    source,
    path,
    parsedLines,
    addedEntries,
    fromOffset: offset,
    toOffset,
    reset,
  };
}

function parseStateJson(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readFromOffset(path: string, offset: number, size: number): Buffer {
  const length = Math.max(0, size - offset);
  if (length === 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

interface OpencodeReport {
  readonly sessions: number;
  readonly changedMessages: number;
  readonly addedEntries: number;
}

function indexOpencode(
  db: Database,
  env: NodeJS.ProcessEnv,
  config: TranscriptConfig,
  warnings: WarningCollector,
  errors: WarningCollector,
  now: () => Date,
  touch: () => void,
): OpencodeReport {
  const path = transcriptPaths(env).opencodeDb;
  if (!existsSync(path)) {
    return { sessions: 0, changedMessages: 0, addedEntries: 0 };
  }

  const sourceDb = openOpencodeReadonly(path);
  if (!sourceDb) {
    const message = `${path}：無法以唯讀方式開啟`;
    errors.add("opencode", message);
    recordWarnings(db, "opencode", path, new Map([[message, 1]]));
    return { sessions: 0, changedMessages: 0, addedEntries: 0 };
  }

  try {
    const schema = detectOpencodeSchema(sourceDb);
    if (!schema) {
      const message = "OpenCode 資料庫沒有可辨識的對話資料表";
      warnings.add("opencode", message);
      recordWarnings(db, "opencode", path, new Map([[message, 1]]));
      return { sessions: 0, changedMessages: 0, addedEntries: 0 };
    }

    const sessions = listOpencodeSessions(sourceDb, schema);
    const seen = new Set<string>();
    let indexedSessions = 0;
    let changedMessages = 0;
    let addedEntries = 0;

    for (const session of sessions) {
      touch();
      const sessionRef = `opencode:${session.sessionId}`;
      seen.add(sessionRef);

      if (isProjectExcluded(session.projectPath ?? undefined, config.excludeProjects)) {
        upsertSessionRow(db, "opencode", sessionRef, session.projectPath, 0);
        removeOpencodeSession(db, sessionRef, true);
        continue;
      }

      const state = db
        .query<{ last_time: number; last_turn: number }, [string]>(
          "SELECT last_time, last_turn FROM opencode_sessions WHERE session_ref = ?",
        )
        .get(sessionRef);
      const watermark = state?.last_time ?? 0;
      if (watermark > 0 && session.timeUpdated <= watermark) continue;

      const changes = readOpencodeChanges(sourceDb, schema, session.sessionId, watermark);
      for (const warning of changes.warnings) {
        warnings.add("opencode", warning.message);
        recordWarnings(db, "opencode", warning.messageRef, new Map([[warning.message, 1]]));
      }

      const sourceMessageIds = listOpencodeMessageIds(sourceDb, schema, session.sessionId);
      const indexedMessages = db
        .query<{ message_ref: string }, [string]>(
          "SELECT message_ref FROM opencode_messages WHERE session_ref = ?",
        )
        .all(sessionRef);
      const removedMessages = indexedMessages
        .map((row) => row.message_ref)
        .filter((messageRef) => !sourceMessageIds.has(messageRef));
      const unreadableMessages = new Set(
        changes.warnings.map((warning) => warning.messageRef),
      );

      let lastTurn = state?.last_turn ?? 0;
      let sessionAdded = 0;

      withImmediateTransaction(db, () => {
        for (const messageRef of unreadableMessages) {
          deleteEntriesForOrigin(db, "opencode", messageRef);
          db.query(
            "DELETE FROM opencode_messages WHERE session_ref = ? AND message_ref = ?",
          ).run(sessionRef, messageRef);
        }

        for (const message of changes.messages) {
          const existing = db
            .query<{ turn: number }, [string, string]>(
              "SELECT turn FROM opencode_messages WHERE session_ref = ? AND message_ref = ?",
            )
            .get(sessionRef, message.messageRef);

          let turn: number;
          if (existing) {
            turn = existing.turn;
            lastTurn = Math.max(lastTurn, turn);
          } else if (message.role === "user") {
            lastTurn += 1;
            turn = lastTurn;
          } else {
            turn = Math.max(lastTurn, 1);
          }

          const entries: ParsedEntry[] = message.blocks.map((block) => ({
            originSeq: message.seq,
            blockIndex: block.blockIndex,
            turn,
            role: block.role,
            text: block.text,
            ...(block.toolName ? { toolName: block.toolName } : {}),
            ...(block.at ? { at: block.at } : {}),
          }));

          deleteEntriesForOrigin(db, "opencode", message.messageRef);
          sessionAdded += insertParsedEntries(db, {
            source: "opencode",
            sessionRef,
            projectPath: session.projectPath,
            origin: message.messageRef,
            entries,
            maxEntryChars: config.maxEntryChars,
          });

          db.query(
            `INSERT INTO opencode_messages (session_ref, message_ref, turn, time_updated)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_ref, message_ref) DO UPDATE SET
               turn = excluded.turn,
               time_updated = excluded.time_updated`,
          ).run(sessionRef, message.messageRef, turn, message.timeUpdated);
        }

        for (const messageRef of removedMessages) {
          deleteEntriesForOrigin(db, "opencode", messageRef);
          db.query(
            "DELETE FROM opencode_messages WHERE session_ref = ? AND message_ref = ?",
          ).run(sessionRef, messageRef);
          db.query("DELETE FROM warnings WHERE source = 'opencode' AND origin = ?").run(
            messageRef,
          );
        }

        upsertSessionRow(db, "opencode", sessionRef, session.projectPath, lastTurn);

        db.query(
          `INSERT INTO opencode_sessions (session_ref, project_path, last_time, last_turn, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_ref) DO UPDATE SET
             project_path = excluded.project_path,
             last_time = MAX(opencode_sessions.last_time, excluded.last_time),
             last_turn = MAX(opencode_sessions.last_turn, excluded.last_turn),
             updated_at = excluded.updated_at`,
        ).run(
          sessionRef,
          session.projectPath,
          Math.max(watermark, changes.maxTime, session.timeUpdated),
          lastTurn,
          now().toISOString(),
        );
      });

      indexedSessions += 1;
      changedMessages += changes.messages.length;
      addedEntries += sessionAdded;
    }

    const indexedSessionsInDb = db
      .query<{ session_ref: string }, []>("SELECT session_ref FROM opencode_sessions")
      .all();
    for (const row of indexedSessionsInDb) {
      if (!seen.has(row.session_ref)) removeOpencodeSession(db, row.session_ref);
    }

    const indexedMessages = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM opencode_messages")
      .get();
    if ((indexedMessages?.count ?? 0) > countIndexableOpencodeMessages(sourceDb, schema)) {
      reconcileOpencodeMessages(db, sourceDb, schema);
    }

    return {
      sessions: indexedSessions,
      changedMessages,
      addedEntries,
    };
  } catch (error) {
    errors.add("opencode", `${path}：${messageOf(error)}`);
    return { sessions: 0, changedMessages: 0, addedEntries: 0 };
  } finally {
    sourceDb.close();
  }
}

/**
 * 來源訊息數量少於索引數量時，代表有訊息被刪除或 compaction 掉。
 * 逐一比對既有 session 的訊息 id，清掉已不存在者的 entries。
 */
function reconcileOpencodeMessages(
  db: Database,
  sourceDb: Database,
  schema: "v2" | "v1",
): void {
  const sessions = db
    .query<{ session_ref: string }, []>("SELECT session_ref FROM opencode_sessions")
    .all();
  for (const session of sessions) {
    const sessionId = session.session_ref.startsWith("opencode:")
      ? session.session_ref.slice("opencode:".length)
      : session.session_ref;
    const sourceIds = listOpencodeMessageIds(sourceDb, schema, sessionId);
    const indexed = db
      .query<{ message_ref: string }, [string]>(
        "SELECT message_ref FROM opencode_messages WHERE session_ref = ?",
      )
      .all(session.session_ref);
    const missing = indexed
      .map((row) => row.message_ref)
      .filter((messageRef) => !sourceIds.has(messageRef));
    if (missing.length === 0) continue;
    withImmediateTransaction(db, () => {
      for (const messageRef of missing) {
        deleteEntriesForOrigin(db, "opencode", messageRef);
        db.query(
          "DELETE FROM opencode_messages WHERE session_ref = ? AND message_ref = ?",
        ).run(session.session_ref, messageRef);
        db.query("DELETE FROM warnings WHERE source = 'opencode' AND origin = ?").run(
          messageRef,
        );
      }
    });
  }
}

function removeOpencodeSession(
  db: Database,
  sessionRef: string,
  keepMetadata = false,
): void {
  withImmediateTransaction(db, () => {
    deleteEntriesForSession(db, sessionRef);
    db.query(
      `DELETE FROM warnings
       WHERE source = 'opencode'
         AND origin IN (SELECT message_ref FROM opencode_messages WHERE session_ref = ?)`,
    ).run(sessionRef);
    db.query("DELETE FROM opencode_messages WHERE session_ref = ?").run(sessionRef);
    db.query("DELETE FROM opencode_sessions WHERE session_ref = ?").run(sessionRef);
    if (!keepMetadata) {
      db.query("DELETE FROM sessions WHERE source = 'opencode' AND session_ref = ?").run(
        sessionRef,
      );
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
