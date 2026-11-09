import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { smileworkTranscriptsPath } from "../shared/paths.ts";
import { ok, type ToolResult } from "../shared/result.ts";
import {
  normalizeProjectPath,
  readTranscriptConfig,
  transcriptConfigFingerprint,
  type TranscriptConfig,
} from "./config.ts";
import {
  countIndexSessions,
  getIndexMeta,
  openTranscriptIndexReadonly,
  readSchemaVersion,
} from "./index-db.ts";
import { isBuildLockActive, buildLockPath } from "./lock.ts";
import {
  TRANSCRIPT_SOURCES,
  type TranscriptIndexState,
  type TranscriptRole,
  type TranscriptSearchInput,
  type TranscriptSearchHit,
  type TranscriptSource,
  type TranscriptWarning,
} from "./types.ts";
import { textLength, truncateText } from "./text.ts";

export interface TranscriptServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: TranscriptConfig;
  readonly dbPath?: string;
  readonly lockPath?: string;
  /** false 時只搜尋現有索引，不啟動背景建立。 */
  readonly autoIndex?: boolean;
  readonly startBuilder?: (context: { env: NodeJS.ProcessEnv; dbPath: string }) => boolean;
  readonly refreshMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_SNIPPET_CHARS = 400;

export function ensureTranscriptIndex(
  options: TranscriptServiceOptions = {},
): TranscriptIndexState {
  const env = options.env ?? process.env;
  const config = options.config ?? readTranscriptConfig(env);
  const dbPath = options.dbPath ?? smileworkTranscriptsPath(env);
  const lockPath = options.lockPath ?? buildLockPath(dbPath);
  const building = isBuildLockActive(lockPath);

  let ready = false;
  let lastIndexedAt: string | null = null;
  let configChanged = false;
  const db = openTranscriptIndexReadonly(dbPath);
  if (db) {
    try {
      const schemaReady = readSchemaVersion(db) === 1 && tableExists(db, "entries");
      lastIndexedAt = getIndexMeta(db, "last_scan_at");
      const storedConfig = getIndexMeta(db, "config_key");
      configChanged =
        storedConfig !== null
          ? storedConfig !== transcriptConfigFingerprint(config)
          : lastIndexedAt !== null;
      // 只有 schema 不算完成索引；第一次建置中必須回報 indexing。
      ready = schemaReady && lastIndexedAt !== null;
    } catch {
      ready = false;
    } finally {
      db.close();
    }
  }

  const refreshMs = options.refreshMs ?? config.refreshMs;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const lastMs = lastIndexedAt ? Date.parse(lastIndexedAt) : Number.NaN;
  const stale =
    !ready || configChanged || Number.isNaN(lastMs) || nowMs - lastMs >= refreshMs;

  let started = false;
  if ((options.autoIndex ?? true) && stale && !building) {
    started = options.startBuilder
      ? options.startBuilder({ env, dbPath })
      : spawnIndexBuilder(env);
  }

  return { ready, building: building || started, started, lastIndexedAt };
}

function tableExists(db: ReturnType<typeof openTranscriptIndexReadonly>, name: string): boolean {
  if (!db) return false;
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return row !== undefined;
}

function spawnIndexBuilder(env: NodeJS.ProcessEnv): boolean {
  const cli = resolveCliEntry();
  if (!cli) return false;
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, cli, "transcripts", "index"],
      env: { ...env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function resolveCliEntry(): string | null {
  const fromArgv = process.argv[1];
  const candidates = [
    ...(fromArgv && /(?:^|[\\/])(?:cli[\\/]index|dist[\\/]index)\.(?:ts|js)$/.test(fromArgv)
      ? [fromArgv]
      : []),
    resolve(import.meta.dir, "..", "cli", "index.ts"),
    resolve(import.meta.dir, "..", "cli", "index.js"),
    resolve(import.meta.dir, "..", "..", "dist", "index.js"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function searchTranscripts(
  input: TranscriptSearchInput,
  options: TranscriptServiceOptions = {},
): ToolResult {
  const env = options.env ?? process.env;
  const config = options.config ?? readTranscriptConfig(env);
  const query = validateQuery(input.query);
  const limit = validateLimit(input.limit);
  if (input.source && !TRANSCRIPT_SOURCES.includes(input.source)) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      `不支援的對話來源：${input.source}`,
      `source 只能是 ${TRANSCRIPT_SOURCES.join("、")}。`,
      { field: "source" },
    );
  }

  const projectFilter = input.project
    ? normalizeProjectPath(input.project, env.HOME ?? "")
    : null;
  const since = input.since ? normalizeSince(input.since) : null;
  const index = ensureTranscriptIndex({ ...options, env, config });
  const dbPath = options.dbPath ?? smileworkTranscriptsPath(env);
  const enabledSources = enabledSourceList(config, input.source);

  if (!index.ready) {
    const indexing = index.building || index.started;
    const summary = indexing
      ? "對話索引正在建立，完成後再搜尋一次。"
      : "對話索引尚未建立，請執行 smilework transcripts index 後再搜尋。";
    return ok(summary, {
      query,
      count: 0,
      results: [],
      hasMore: false,
      indexing,
      filters: {
        source: input.source ?? null,
        project: projectFilter,
        since,
        limit,
      },
      index,
      warnings: [],
    });
  }

  if (enabledSources.length === 0) {
    return ok(input.source ? "指定的對話來源已關閉，沒有搜尋。" : "所有對話來源都已關閉，沒有搜尋。", {
      query,
      count: 0,
      results: [],
      hasMore: false,
      indexing: false,
      filters: {
        source: input.source ?? null,
        project: projectFilter,
        since,
        limit,
      },
      index,
      warnings: [],
    });
  }

  const db = openTranscriptIndexReadonly(dbPath);
  if (!db) {
    return ok("對話索引正在建立，完成後再搜尋一次。", {
      query,
      count: 0,
      results: [],
      hasMore: false,
      indexing: index.building || index.started,
      filters: { source: input.source ?? null, project: projectFilter, since, limit },
      index,
      warnings: [],
    });
  }

  try {
    const results = runSearch(db, {
      query,
      limit,
      sources: enabledSources,
      project: projectFilter,
      since,
      excludeProjects: config.excludeProjects,
    });
    const warnings = readWarnings(db, enabledSources);
    const sessions = countIndexSessions(db);

    return ok(
      results.length === 0
        ? "沒有找到符合的對話片段。"
        : `找到 ${results.length} 筆對話片段。`,
      {
        query,
        count: results.length,
        results,
        hasMore: results.length >= limit,
        indexing: false,
        filters: {
          source: input.source ?? null,
          project: projectFilter,
          since,
          limit,
        },
        index: { ...index, sessions },
        warnings,
      },
    );
  } catch (error) {
    if (error instanceof SmileworkError) throw error;
    throw new SmileworkError(
      ERROR_CODES.database,
      "讀取對話索引失敗。",
      "重建索引後再試一次：smilework transcripts index。",
      { message: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    db.close();
  }
}

function enabledSourceList(
  config: TranscriptConfig,
  requested: TranscriptSource | undefined,
): TranscriptSource[] {
  if (requested) return config.sources[requested] ? [requested] : [];
  return TRANSCRIPT_SOURCES.filter((source) => config.sources[source]);
}

interface SearchQuery {
  readonly query: string;
  readonly limit: number;
  readonly sources: readonly TranscriptSource[];
  readonly project: string | null;
  readonly since: string | null;
  readonly excludeProjects: readonly string[];
}

interface SearchRow {
  source: string;
  session_ref: string;
  project_path: string | null;
  turn: number;
  role: string;
  text: string;
  tool_name: string | null;
  at: string | null;
  fragment: string | null;
}

function runSearch(db: ReturnType<typeof openTranscriptIndexReadonly>, query: SearchQuery): TranscriptSearchHit[] {
  if (!db) return [];
  const tokens = queryTokens(query.query);
  const useLike = tokens.length === 0 || tokens.some((token) => textLength(token) < 3);
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (useLike) {
    // 混合長短 token 時不能只比對整段字串；每個 token 各自做子字串比對。
    for (const token of tokens) {
      where.push("e.text LIKE ? ESCAPE '!'");
      params.push(`%${escapeLike(token)}%`);
    }
  }

  where.push(`e.source IN (${query.sources.map(() => "?").join(", ")})`);
  params.push(...query.sources);

  if (query.project) {
    where.push("(e.project_path = ? OR e.project_path LIKE ? ESCAPE '!')");
    params.push(query.project, `${escapeLike(query.project)}${sep}%`);
  }
  for (const excluded of query.excludeProjects) {
    where.push(
      "(e.project_path IS NULL OR (e.project_path <> ? AND e.project_path NOT LIKE ? ESCAPE '!'))",
    );
    params.push(excluded, `${escapeLike(excluded)}${sep}%`);
  }
  if (query.since) {
    where.push("e.at IS NOT NULL AND e.at >= ?");
    params.push(query.since);
  }
  params.push(query.limit);

  const sql = useLike
    ? `SELECT e.source, e.session_ref, e.project_path, e.turn, e.role, e.text,
              e.tool_name, e.at, NULL AS fragment
       FROM entries e
       WHERE ${where.join(" AND ")}
       ORDER BY e.at DESC, e.entry_id DESC
       LIMIT ?`
    : `SELECT e.source, e.session_ref, e.project_path, e.turn, e.role, e.text,
              e.tool_name, e.at,
              snippet(entries_fts, 0, '[', ']', '…', 16) AS fragment
       FROM entries_fts
       JOIN entries e ON e.entry_id = entries_fts.rowid
       WHERE entries_fts MATCH ? AND ${where.join(" AND ")}
       ORDER BY bm25(entries_fts), e.entry_id
       LIMIT ?`;

  const statement = db.query<SearchRow, Array<string | number>>(sql);
  const rows = useLike
    ? statement.all(...params)
    : statement.all(buildFtsExpression(query.query), ...params);

  return rows.map((row) => {
    const text = typeof row.text === "string" ? row.text : "";
    const snippet = useLike
      ? manualSnippet(text, snippetToken(text, tokens))
      : truncateText(row.fragment ?? text, MAX_SNIPPET_CHARS);
    return {
      source: row.source as TranscriptSource,
      sessionRef: row.session_ref,
      ...(row.project_path ? { projectPath: row.project_path } : {}),
      turn: row.turn,
      role: row.role as TranscriptRole,
      text: snippet,
      ...(row.tool_name ? { toolName: row.tool_name } : {}),
      ...(row.at ? { at: row.at } : {}),
    };
  });
}

function readWarnings(
  db: ReturnType<typeof openTranscriptIndexReadonly>,
  sources: readonly TranscriptSource[],
): TranscriptWarning[] {
  if (!db || sources.length === 0) return [];
  const placeholders = sources.map(() => "?").join(", ");
  const rows = db
    .query<{ source: string; message: string; occurrences: number }, string[]>(
      `SELECT source, message, occurrences FROM warnings
       WHERE source IN (${placeholders})
       ORDER BY updated_at DESC
       LIMIT 10`,
    )
    .all(...sources);
  return rows.map((row) => ({
    source: row.source as TranscriptSource,
    message: row.message,
    occurrences: row.occurrences,
  }));
}

/** trigram 對 1 到 2 個字元的 token 沒有結果，這類查詢改用逐 token 的 LIKE。 */
function queryTokens(query: string): string[] {
  return query.split(/\s+/).filter(Boolean);
}

function snippetToken(text: string, tokens: readonly string[]): string {
  let best = tokens[0] ?? "";
  let bestLength = textLength(best);
  const lowerText = text.toLocaleLowerCase();
  for (const token of tokens) {
    const length = textLength(token);
    if (length <= bestLength) continue;
    if (!lowerText.includes(token.toLocaleLowerCase())) continue;
    best = token;
    bestLength = length;
  }
  return best;
}

function buildFtsExpression(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function escapeLike(query: string): string {
  return query.replace(/[!%_]/g, (match) => `!${match}`);
}

function manualSnippet(text: string, query: string): string {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return truncateText(text, MAX_SNIPPET_CHARS);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + query.length + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const before = text.slice(start, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length, end);
  return truncateText(`${prefix}${before}[${match}]${after}${suffix}`, MAX_SNIPPET_CHARS);
}

function validateQuery(value: string): string {
  const query = value.trim();
  if (!query) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      "搜尋關鍵字不能是空的。",
      "輸入至少一個字元的關鍵字。",
      { field: "query" },
    );
  }
  if (textLength(query) > 500) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      "搜尋關鍵字過長。",
      "把關鍵字縮短到 500 個字元以內。",
      { field: "query", maxChars: 500 },
    );
  }
  return query;
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      `limit 必須是 1 到 ${MAX_LIMIT} 的整數。`,
      `改用 1 到 ${MAX_LIMIT} 之間的整數。`,
      { field: "limit", max: MAX_LIMIT },
    );
  }
  return limit;
}

function normalizeSince(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return trimmed;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      "since 不是有效的時間。",
      "使用 ISO 8601 時間，例如 2026-11-01 或 2026-11-01T00:00:00Z。",
      { field: "since" },
    );
  }
  return parsed.toISOString();
}
