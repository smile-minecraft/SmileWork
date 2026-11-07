import { Database } from "bun:sqlite";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { withTempDir } from "../helpers/temp.ts";

export interface TranscriptTestContext {
  readonly root: string;
  readonly fakeHome: string;
  readonly home: string;
  readonly xdgDataHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dbPath: string;
}

export async function withTranscriptEnv<T>(
  prefix: string,
  run: (context: TranscriptTestContext) => T | Promise<T>,
): Promise<T> {
  return withTempDir(prefix, async (root) => {
    const fakeHome = join(root, "home");
    const home = join(fakeHome, ".smilework");
    const xdgDataHome = join(root, "xdg");
    await mkdir(home, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      HOME: fakeHome,
      XDG_DATA_HOME: xdgDataHome,
      SMILEWORK_HOME: home,
      PATH: process.env.PATH,
    };
    return run({
      root,
      fakeHome,
      home,
      xdgDataHome,
      env,
      dbPath: join(home, "transcripts.db"),
    });
  });
}

export function fixturePath(...parts: string[]): string {
  return join(import.meta.dir, "fixtures", ...parts);
}

export async function writeClaudeJsonl(
  fakeHome: string,
  fileName: string,
  lines: readonly (object | string)[],
): Promise<string> {
  const path = join(fakeHome, ".claude", "projects", "fixture-project", fileName);
  await writeJsonl(path, lines);
  return path;
}

export async function writeCodexJsonl(
  fakeHome: string,
  fileName: string,
  lines: readonly (object | string)[],
): Promise<string> {
  const path = join(fakeHome, ".codex", "sessions", "2026", "11", "02", fileName);
  await writeJsonl(path, lines);
  return path;
}

async function writeJsonl(path: string, lines: readonly (object | string)[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map(lineText).join("\n")}\n`, "utf8");
}

export async function appendJsonl(
  path: string,
  lines: readonly (object | string)[],
): Promise<void> {
  await appendFile(path, `${lines.map(lineText).join("\n")}\n`, "utf8");
}

function lineText(line: object | string): string {
  return typeof line === "string" ? line : JSON.stringify(line);
}

export interface OpencodeSessionFixture {
  readonly id: string;
  readonly directory: string | null;
  readonly timeUpdated: number;
}

export interface OpencodeMessageFixture {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly seq: number;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly data: unknown;
}

/** 建立目前 OpenCode 版本（session_v2/session_message）的最小資料庫。 */
export function createOpencodeV2Database(
  path: string,
  sessions: readonly OpencodeSessionFixture[],
  messages: readonly OpencodeMessageFixture[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        directory TEXT,
        time_updated INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
    `);
    const sessionStatement = db.query(
      "INSERT INTO session_v2 (id, directory, time_updated) VALUES (?, ?, ?)",
    );
    for (const session of sessions) {
      sessionStatement.run(session.id, session.directory, session.timeUpdated);
    }
    insertOpencodeMessages(db, messages);
  } finally {
    db.close();
  }
}

export function insertOpencodeMessages(
  db: Database,
  messages: readonly OpencodeMessageFixture[],
): void {
  const statement = db.query(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const message of messages) {
    statement.run(
      message.id,
      message.sessionId,
      message.type,
      message.seq,
      message.timeCreated,
      message.timeUpdated,
      JSON.stringify(message.data),
    );
  }
}

export interface OpencodeV1Fixture {
  readonly session: { id: string; directory: string | null; timeUpdated: number };
  readonly messages: readonly {
    id: string;
    role: "user" | "assistant";
    timeCreated: number;
    timeUpdated: number;
    data: unknown;
    parts: readonly { id: string; type: string; timeCreated: number; timeUpdated: number; data: unknown }[];
  }[];
}

/** 舊版 OpenCode 的 session/message/part 資料庫，用來確認相容性。 */
export function createOpencodeV1Database(path: string, fixture: OpencodeV1Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.query("INSERT INTO session (id, directory, time_updated) VALUES (?, ?, ?)").run(
      fixture.session.id,
      fixture.session.directory,
      fixture.session.timeUpdated,
    );
    const messageStatement = db.query(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const partStatement = db.query(
      `INSERT INTO part (id, message_id, session_id, type, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of fixture.messages) {
      messageStatement.run(
        message.id,
        fixture.session.id,
        message.timeCreated,
        message.timeUpdated,
        JSON.stringify(message.data),
      );
      for (const part of message.parts) {
        partStatement.run(
          part.id,
          message.id,
          fixture.session.id,
          part.type,
          part.timeCreated,
          part.timeUpdated,
          JSON.stringify(part.data),
        );
      }
    }
  } finally {
    db.close();
  }
}

export function appendOpencodeMessages(
  path: string,
  messages: readonly OpencodeMessageFixture[],
  sessionUpdate?: { sessionId: string; timeUpdated: number },
): void {
  const db = new Database(path);
  try {
    insertOpencodeMessages(db, messages);
    if (sessionUpdate) {
      db.query("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(
        sessionUpdate.timeUpdated,
        sessionUpdate.sessionId,
      );
    }
  } finally {
    db.close();
  }
}

export function updateOpencodeMessage(
  path: string,
  messageId: string,
  data: unknown,
  timeUpdated: number,
  sessionId: string,
): void {
  const db = new Database(path);
  try {
    db.query("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?").run(
      JSON.stringify(data),
      timeUpdated,
      messageId,
    );
    db.query("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(timeUpdated, sessionId);
  } finally {
    db.close();
  }
}

/** 直接刪除單一訊息，模擬 compaction 或使用者刪除對話。 */
export function deleteOpencodeMessage(
  path: string,
  messageId: string,
  sessionId: string,
  timeUpdated: number,
): void {
  const db = new Database(path);
  try {
    db.query("DELETE FROM session_message WHERE id = ?").run(messageId);
    db.query("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(timeUpdated, sessionId);
  } finally {
    db.close();
  }
}

/** 寫入原始 data 字串，讓測試可以構造壞 JSON。 */
export function insertRawOpencodeMessage(
  path: string,
  row: {
    id: string;
    sessionId: string;
    type: string;
    seq: number;
    timeCreated: number;
    timeUpdated: number;
    rawData: string;
  },
): void {
  const db = new Database(path);
  try {
    db.query(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.sessionId,
      row.type,
      row.seq,
      row.timeCreated,
      row.timeUpdated,
      row.rawData,
    );
    db.query("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(
      row.timeUpdated,
      row.sessionId,
    );
  } finally {
    db.close();
  }
}

export function countTableRows(
  dbPath: string,
  table: string,
  source?: string,
): number {
  const allowed = new Set([
    "entries",
    "source_files",
    "sessions",
    "warnings",
    "opencode_sessions",
    "opencode_messages",
  ]);
  if (!allowed.has(table)) throw new Error(`不允許的測試資料表：${table}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = source
      ? db
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM ${table} WHERE source = ?`,
          )
          .get(source)
      : db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

export interface IndexedEntryRow {
  readonly entry_id: number;
  readonly source: string;
  readonly session_ref: string;
  readonly project_path: string | null;
  readonly turn: number;
  readonly role: string;
  readonly text: string;
  readonly tool_name: string | null;
  readonly at: string | null;
  readonly origin: string;
  readonly origin_seq: number;
  readonly block_index: number;
}

export function readIndexEntries(dbPath: string, sessionRef?: string): IndexedEntryRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    if (sessionRef) {
      return db
        .query<IndexedEntryRow, [string]>(
          `SELECT entry_id, source, session_ref, project_path, turn, role, text, tool_name, at,
                  origin, origin_seq, block_index
           FROM entries WHERE session_ref = ?
           ORDER BY turn, origin_seq, block_index, entry_id`,
        )
        .all(sessionRef);
    }
    return db
      .query<IndexedEntryRow, []>(
        `SELECT entry_id, source, session_ref, project_path, turn, role, text, tool_name, at,
                origin, origin_seq, block_index
         FROM entries
         ORDER BY session_ref, turn, origin_seq, block_index, entry_id`,
      )
      .all();
  } finally {
    db.close();
  }
}

export interface IndexedWarningRow {
  readonly source: string;
  readonly origin: string;
  readonly message: string;
  readonly occurrences: number;
}

export function readIndexWarnings(dbPath: string): IndexedWarningRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<IndexedWarningRow, []>(
        "SELECT source, origin, message, occurrences FROM warnings ORDER BY source, message",
      )
      .all();
  } finally {
    db.close();
  }
}

export function claudeUser(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: text },
    cwd: "/work/alpha",
    sessionId: "claude-incremental-1",
    timestamp: "2026-11-01T12:00:00.000Z",
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

export function claudeAssistant(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    cwd: "/work/alpha",
    sessionId: "claude-incremental-1",
    timestamp: "2026-11-01T12:00:01.000Z",
    uuid: `a-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}
