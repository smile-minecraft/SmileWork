import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { TranscriptRole } from "../types.ts";
import { asRecord, asString, contentToText, normalizeTimestamp, valueToText } from "./shared.ts";

export type OpencodeSchema = "v2" | "v1";

export interface OpencodeSessionRow {
  readonly sessionId: string;
  readonly projectPath: string | null;
  readonly timeUpdated: number;
}

export interface OpencodeMessageBlock {
  readonly blockIndex: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly toolName?: string;
  readonly at?: string;
}

export interface OpencodeMessage {
  readonly messageRef: string;
  readonly seq: number;
  readonly role: TranscriptRole;
  readonly timeUpdated: number;
  readonly blocks: readonly OpencodeMessageBlock[];
}

export interface OpencodeWarning {
  readonly messageRef: string;
  readonly message: string;
}

export interface OpencodeChanges {
  readonly messages: readonly OpencodeMessage[];
  readonly maxTime: number;
  readonly warnings: readonly OpencodeWarning[];
}

export function openOpencodeReadonly(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 8000");
    return db;
  } catch {
    return null;
  }
}

export function detectOpencodeSchema(db: Database): OpencodeSchema | null {
  const names = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (names.has("session_v2") && names.has("session_message")) return "v2";
  if (names.has("session") && names.has("message") && names.has("part")) return "v1";
  return null;
}

export function listOpencodeSessions(
  db: Database,
  schema: OpencodeSchema,
): readonly OpencodeSessionRow[] {
  const rows =
    schema === "v2"
      ? db
          .query<{ id: string; directory: string | null; time_updated: number | null }, []>(
            "SELECT id, directory, time_updated FROM session_v2 ORDER BY time_updated",
          )
          .all()
      : db
          .query<{ id: string; directory: string | null; time_updated: number | null }, []>(
            "SELECT id, directory, time_updated FROM session ORDER BY time_updated",
          )
          .all();

  return rows.map((row) => ({
    sessionId: row.id,
    projectPath: row.directory ?? null,
    timeUpdated: typeof row.time_updated === "number" ? row.time_updated : 0,
  }));
}

/** 取得來源目前仍存在的訊息 id，用來清理被刪除或 compaction 掉的舊索引。 */
export function listOpencodeMessageIds(
  db: Database,
  schema: OpencodeSchema,
  sessionId: string,
): Set<string> {
  const rows =
    schema === "v2"
      ? db
          .query<{ id: string }, [string]>(
            "SELECT id FROM session_message WHERE session_id = ?",
          )
          .all(sessionId)
      : db
          .query<{ id: string }, [string]>("SELECT id FROM message WHERE session_id = ?")
          .all(sessionId);
  return new Set(rows.map((row) => row.id));
}

/** 可索引的角色數量；用來偵測訊息是否被刪除。 */
export function countIndexableOpencodeMessages(db: Database, schema: OpencodeSchema): number {
  const row =
    schema === "v2"
      ? db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM session_message WHERE type IN ('user', 'assistant')",
          )
          .get()
      : db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM message").get();
  return row?.count ?? 0;
}

/** 只取時間戳比上次索引新的訊息；呼叫端以 session 為單位保存水位。 */
export function readOpencodeChanges(
  db: Database,
  schema: OpencodeSchema,
  sessionId: string,
  sinceTime: number,
): OpencodeChanges {
  return schema === "v2"
    ? readChangesV2(db, sessionId, sinceTime)
    : readChangesV1(db, sessionId, sinceTime);
}

interface V2MessageRow {
  id: string;
  seq: number | null;
  type: string | null;
  time_created: number | null;
  time_updated: number | null;
  data: string | null;
}

function readChangesV2(db: Database, sessionId: string, sinceTime: number): OpencodeChanges {
  const rows = db
    .query<V2MessageRow, [string, number]>(
      `SELECT id, seq, type, time_created, time_updated, data
       FROM session_message
       WHERE session_id = ? AND time_updated > ?
       ORDER BY seq, id`,
    )
    .all(sessionId, sinceTime);

  const messages: OpencodeMessage[] = [];
  const warnings: OpencodeWarning[] = [];
  let maxTime = sinceTime;

  for (const row of rows) {
    maxTime = Math.max(maxTime, row.time_updated ?? 0, row.time_created ?? 0);
    const data = parseJson(row.data);
    if (!data) {
      warnings.push({ messageRef: row.id, message: "OpenCode 訊息內容不是有效的 JSON" });
      continue;
    }
    const role = roleForOpencodeType(row.type ?? asString(data.role) ?? asString(data.type));
    if (!role) continue;
    messages.push({
      messageRef: row.id,
      seq: typeof row.seq === "number" ? row.seq : messages.length,
      role,
      timeUpdated: row.time_updated ?? 0,
      blocks: blocksV2(role, data, row.time_created),
    });
  }

  return { messages, maxTime, warnings };
}

function roleForOpencodeType(value: string | undefined): TranscriptRole | null {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  return null;
}

function blocksV2(
  role: TranscriptRole,
  data: Record<string, unknown>,
  timeCreated: number | null,
): readonly OpencodeMessageBlock[] {
  const at = normalizeTimestamp(asRecord(data.time)?.created ?? timeCreated);
  if (role === "user") {
    const text =
      asString(data.text) ??
      (data.content ? contentToText(data.content) : "");
    return text ? [{ blockIndex: 0, role, text, at }] : [];
  }

  const content = data.content;
  if (!Array.isArray(content)) {
    const text = asString(data.text) ?? contentToText(content);
    return text ? [{ blockIndex: 0, role, text, at }] : [];
  }

  const blocks: OpencodeMessageBlock[] = [];
  let blockIndex = 0;
  let pendingText: string[] = [];
  const flushText = (): void => {
    if (pendingText.length === 0) return;
    blocks.push({ blockIndex: blockIndex++, role: "assistant", text: pendingText.join("\n"), at });
    pendingText = [];
  };

  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    const type = asString(block.type);
    if (type === "text") {
      const text = asString(block.text);
      if (text) pendingText.push(text);
      continue;
    }
    if (type === "tool") {
      flushText();
      const toolName = asString(block.name) ?? asString(block.tool);
      const state = asRecord(block.state);
      const text = toolStateText(state, block);
      if (text) blocks.push({ blockIndex: blockIndex++, role: "tool", text, toolName, at });
    }
  }
  flushText();

  return blocks;
}

/**
 * OpenCode v2 的工具輸出放在 state.content，舊版放在 state.output。
 * 先取出可讀文字，再依序退回 output、input 與整個 state。
 */
function toolStateText(state: Record<string, unknown> | null, fallback: unknown): string {
  if (state) {
    const content = state.content;
    if (content !== undefined && content !== null) {
      const contentRecord = asRecord(content);
      const text = contentRecord ? contentToText([contentRecord]) : contentToText(content);
      if (text.trim()) return text;
    }

    const output = state.output;
    if (output !== undefined && output !== null) {
      const text = typeof output === "string" ? output : valueToText(output);
      if (text.trim()) return text;
    }

    if (state.input !== undefined) {
      const text = valueToText(state.input);
      if (text.trim()) return text;
    }

    const stateText = valueToText(state);
    if (stateText.trim() && stateText !== "{}") return stateText;
  }
  return valueToText(fallback);
}

interface V1MessageRow {
  rowid: number;
  id: string;
  data: string | null;
  time_created: number | null;
  time_updated: number | null;
  part_updated: number | null;
}

interface V1PartRow {
  data: string | null;
  time_created: number | null;
  time_updated: number | null;
}

function readChangesV1(db: Database, sessionId: string, sinceTime: number): OpencodeChanges {
  const rows = db
    .query<V1MessageRow, [string, number, number]>(
      `SELECT m.rowid AS rowid, m.id AS id, m.data AS data,
              m.time_created AS time_created, m.time_updated AS time_updated,
              COALESCE((SELECT MAX(p.time_updated) FROM part p WHERE p.message_id = m.id), 0) AS part_updated
       FROM message m
       WHERE m.session_id = ?
         AND (m.time_updated > ?
              OR EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id AND p.time_updated > ?))
       ORDER BY m.rowid`,
    )
    .all(sessionId, sinceTime, sinceTime);

  const messages: OpencodeMessage[] = [];
  const warnings: OpencodeWarning[] = [];
  let maxTime = sinceTime;

  for (const row of rows) {
    maxTime = Math.max(maxTime, row.time_updated ?? 0, row.part_updated ?? 0);
    const data = parseJson(row.data);
    if (!data) {
      warnings.push({ messageRef: row.id, message: "OpenCode 訊息內容不是有效的 JSON" });
      continue;
    }
    const role = roleForOpencodeType(asString(data.role) ?? asString(data.type));
    if (!role) continue;

    const parts = db
      .query<V1PartRow, [string]>(
        `SELECT data, time_created, time_updated FROM part
         WHERE message_id = ? ORDER BY time_created, id`,
      )
      .all(row.id);

    const blocks: OpencodeMessageBlock[] = [];
    let blockIndex = 0;
    for (const part of parts) {
      maxTime = Math.max(maxTime, part.time_updated ?? 0);
      const partData = parseJson(part.data);
      if (!partData) {
        warnings.push({ messageRef: row.id, message: "OpenCode part 內容不是有效的 JSON" });
        continue;
      }
      const block = partV1(partData, part.time_created ?? row.time_created, role, blockIndex);
      if (!block) continue;
      blocks.push(block);
      blockIndex += 1;
    }

    messages.push({
      messageRef: row.id,
      seq: row.rowid,
      role,
      timeUpdated: Math.max(row.time_updated ?? 0, row.part_updated ?? 0),
      blocks,
    });
  }

  return { messages, maxTime, warnings };
}

function partV1(
  data: Record<string, unknown>,
  timeCreated: number | null,
  role: TranscriptRole,
  blockIndex: number,
): OpencodeMessageBlock | null {
  const at = normalizeTimestamp(asRecord(data.time)?.created ?? timeCreated);
  const type = asString(data.type);
  if (type === "text") {
    const text = asString(data.text);
    return text ? { blockIndex, role, text, at } : null;
  }
  if (type === "tool") {
    const toolName = asString(data.tool) ?? asString(data.name);
    const state = asRecord(data.state);
    const text = toolStateText(state, data);
    return text ? { blockIndex, role: "tool", text, toolName, at } : null;
  }
  return null;
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
