import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { smileworkTranscriptsPath } from "../shared/paths.ts";
import { ok, type ToolResult } from "../shared/result.ts";
import { isProjectExcluded, readTranscriptConfig } from "./config.ts";
import { openTranscriptIndexReadonly } from "./index-db.ts";
import { textLength, truncateText } from "./text.ts";
import {
  isTranscriptSource,
  type TranscriptReadEntry,
  type TranscriptReadInput,
  type TranscriptRole,
  type TranscriptSource,
} from "./types.ts";
import type { TranscriptServiceOptions } from "./search.ts";

const DEFAULT_MAX_TURNS = 10;
const MAX_TURNS_LIMIT = 50;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_LIMIT = 50_000;
const ROW_LIMIT = 5_000;

export const TRANSCRIPT_READ_ERRORS = {
  sourceDisabled: "TRANSCRIPT_SOURCE_DISABLED",
  projectExcluded: "TRANSCRIPT_PROJECT_EXCLUDED",
} as const;

interface SessionInfoRow {
  source: string;
  project_path: string | null;
}

interface ReadRow {
  source: string;
  session_ref: string;
  project_path: string | null;
  turn: number;
  role: string;
  text: string;
  tool_name: string | null;
  at: string | null;
}

export function readTranscriptSession(
  input: TranscriptReadInput,
  options: TranscriptServiceOptions = {},
): ToolResult {
  const sessionRef = input.sessionRef?.trim();
  if (!sessionRef) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      "sessionRef 不能是空的。",
      "從 transcript_search 的結果取得 sessionRef。",
      { field: "sessionRef" },
    );
  }

  const fromTurn = validateInteger(input.fromTurn ?? 1, 1, Number.MAX_SAFE_INTEGER, "fromTurn");
  const maxTurns = validateInteger(
    input.maxTurns ?? DEFAULT_MAX_TURNS,
    1,
    MAX_TURNS_LIMIT,
    "maxTurns",
  );
  const maxChars = validateInteger(
    input.maxChars ?? DEFAULT_MAX_CHARS,
    100,
    MAX_CHARS_LIMIT,
    "maxChars",
  );

  const env = options.env ?? process.env;
  const config = options.config ?? readTranscriptConfig(env);
  const dbPath = options.dbPath ?? smileworkTranscriptsPath(env);
  const referencedSource = sourceFromSessionRef(sessionRef);
  if (referencedSource && !config.sources[referencedSource]) {
    throw sourceDisabledError(sessionRef, referencedSource);
  }

  const db = openTranscriptIndexReadonly(dbPath);
  if (!db) {
    throw new SmileworkError(
      ERROR_CODES.notFound,
      "對話索引尚未建立。",
      "先執行 transcript_search 觸發索引，或執行 smilework transcripts index。",
      { sessionRef },
    );
  }

  let rows: ReadRow[];
  let sessionInfo: SessionInfoRow | null = null;
  try {
    sessionInfo =
      db
        .query<SessionInfoRow, [string]>(
          "SELECT source, project_path FROM sessions WHERE session_ref = ? LIMIT 1",
        )
        .get(sessionRef) ??
      db
        .query<SessionInfoRow, [string]>(
          "SELECT source, project_path FROM entries WHERE session_ref = ? LIMIT 1",
        )
        .get(sessionRef) ??
      null;

    const effectiveSource = isTranscriptSource(sessionInfo?.source)
      ? sessionInfo.source
      : referencedSource;
    if (effectiveSource && !config.sources[effectiveSource]) {
      throw sourceDisabledError(sessionRef, effectiveSource);
    }
    if (sessionInfo?.project_path && isProjectExcluded(sessionInfo.project_path, config.excludeProjects)) {
      throw projectExcludedError(sessionRef, sessionInfo.project_path);
    }

    rows = db
      .query<ReadRow, [string, number, number]>(
        `SELECT source, session_ref, project_path, turn, role, text, tool_name, at
         FROM entries
         WHERE session_ref = ? AND turn >= ?
         ORDER BY turn, origin_seq, block_index, entry_id
         LIMIT ?`,
      )
      .all(sessionRef, fromTurn, ROW_LIMIT);
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

  if (!sessionInfo) {
    throw new SmileworkError(
      ERROR_CODES.notFound,
      `索引中找不到對話 ${sessionRef}。`,
      "確認 sessionRef 正確，或先執行 transcript_search 更新索引。",
      { sessionRef },
    );
  }

  if (rows.length === 0) {
    return ok("指定回合之後沒有訊息。", {
      sessionRef,
      source: isTranscriptSource(sessionInfo.source) ? sessionInfo.source : undefined,
      projectPath: sessionInfo.project_path,
      fromTurn,
      maxTurns,
      maxChars,
      entries: [],
      returnedChars: 0,
      truncated: false,
      truncatedBy: null,
      nextTurn: null,
    });
  }

  const entries: TranscriptReadEntry[] = [];
  let usedChars = 0;
  let turnsSeen = 0;
  let currentTurn: number | null = null;
  let truncated = false;
  let truncatedBy: "turns" | "chars" | "rows" | null = null;
  let nextTurn: number | null = null;

  for (const row of rows) {
    const turn = row.turn;
    if (turn !== currentTurn) {
      if (turnsSeen >= maxTurns) {
        truncated = true;
        truncatedBy = "turns";
        nextTurn = turn;
        break;
      }
      turnsSeen += 1;
      currentTurn = turn;
    }

    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      truncated = true;
      truncatedBy = "chars";
      break;
    }

    const length = textLength(row.text);
    const text = length > remaining ? truncateText(row.text, remaining) : row.text;
    entries.push({
      turn,
      role: row.role as TranscriptRole,
      text,
      ...(row.tool_name ? { toolName: row.tool_name } : {}),
      ...(row.at ? { at: row.at } : {}),
    });
    usedChars += textLength(text);
    if (length > remaining) {
      truncated = true;
      truncatedBy = "chars";
      break;
    }
  }

  if (!truncated && rows.length >= ROW_LIMIT) {
    truncated = true;
    truncatedBy = "rows";
  }

  const first = rows[0];
  return ok(`讀取 ${entries.length} 則訊息（${turnsSeen} 個回合）。`, {
    sessionRef,
    source: first?.source as TranscriptSource | undefined,
    projectPath: first?.project_path ?? null,
    fromTurn,
    maxTurns,
    maxChars,
    entries,
    returnedChars: usedChars,
    truncated,
    truncatedBy,
    nextTurn,
  });
}

function validateInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SmileworkError(
      ERROR_CODES.invalidInput,
      `${field} 必須是 ${minimum} 到 ${maximum} 的整數。`,
      `改用 ${minimum} 到 ${maximum} 之間的整數。`,
      { field, minimum, maximum },
    );
  }
  return value;
}

function sourceFromSessionRef(sessionRef: string): TranscriptSource | null {
  const separator = sessionRef.indexOf(":");
  if (separator <= 0) return null;
  const prefix = sessionRef.slice(0, separator);
  return isTranscriptSource(prefix) ? prefix : null;
}

function sourceDisabledError(sessionRef: string, source: TranscriptSource): SmileworkError {
  return new SmileworkError(
    TRANSCRIPT_READ_ERRORS.sourceDisabled,
    `對話來源 ${source} 已關閉，不能讀取。`,
    `從 SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES 移除 ${source} 後重建索引，或改讀其他來源的對話。`,
    { sessionRef, source },
  );
}

function projectExcludedError(sessionRef: string, projectPath: string): SmileworkError {
  return new SmileworkError(
    TRANSCRIPT_READ_ERRORS.projectExcluded,
    "這個對話所屬的專案已被排除，不能讀取。",
    "從專案排除清單 SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS 移除該專案後重建索引，或改讀其他對話。",
    { sessionRef, projectPath },
  );
}
