import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildTranscriptIndex } from "../../src/transcripts/indexer.ts";
import { readTranscriptSession } from "../../src/transcripts/read.ts";
import { searchTranscripts } from "../../src/transcripts/search.ts";
import {
  createOpencodeV1Database,
  createOpencodeV2Database,
  fixturePath,
  readIndexEntries,
  readIndexWarnings,
  withTranscriptEnv,
} from "./helpers.ts";

const baseTime = Date.parse("2026-11-01T12:00:00.000Z");

describe("Claude Code adapter", () => {
  test("解析 user、assistant 與工具結果，回合從使用者訊息開始", async () => {
    await withTranscriptEnv("adapter-claude", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };
      const report = buildTranscriptIndex({ env, dbPath: context.dbPath });
      expect(report.errors).toEqual([]);

      const entries = readIndexEntries(context.dbPath, "claude:claude-fixture-1");
      expect(entries.map((entry) => entry.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "tool",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(entries.map((entry) => entry.turn)).toEqual([1, 1, 1, 1, 1, 2, 2]);
      expect(entries.every((entry) => entry.source === "claude")).toBe(true);
      expect(entries.every((entry) => entry.project_path === "/work/alpha")).toBe(true);

      const toolUse = entries[2];
      expect(toolUse?.tool_name).toBe("Read");
      expect(toolUse?.text).toContain("src/worker.ts");

      const toolResult = entries[3];
      expect(toolResult?.tool_name).toBe("Read");
      expect(toolResult?.text).toContain("結案條件");

      expect(entries[0]?.at).toBe("2026-11-01T10:00:00.000Z");
      expect(entries[1]?.text).toContain("timeout");
    });
  });

  test("讀不懂的行只記警告，仍保留前後可解析的訊息", async () => {
    await withTranscriptEnv("adapter-claude-unknown", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };
      const report = buildTranscriptIndex({ env, dbPath: context.dbPath });

      const entries = readIndexEntries(context.dbPath, "claude:claude-unknown-1");
      expect(entries.map((entry) => entry.text)).toEqual([
        "unknown format still keeps this message",
        "the next valid entry",
      ]);

      const warnings = readIndexWarnings(context.dbPath);
      const messages = warnings.map((warning) => warning.message).join("\n");
      expect(messages).toContain("不是有效的 JSON 行");
      expect(messages).toContain("Claude Code 紀錄類型無法辨識：mystery");
      expect(report.warnings.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("Codex adapter", () => {
  test("解析 rollout 的訊息、工具呼叫與工具輸出", async () => {
    await withTranscriptEnv("adapter-codex", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CODEX_SESSIONS_DIR: fixturePath("codex"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,opencode",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const entries = readIndexEntries(context.dbPath, "codex:codex-fixture-1");
      expect(entries.map((entry) => entry.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "tool",
        "user",
        "assistant",
      ]);
      expect(entries.map((entry) => entry.turn)).toEqual([1, 1, 1, 1, 2, 2]);
      expect(entries.every((entry) => entry.project_path === "/work/beta")).toBe(true);

      const call = entries[2];
      expect(call?.tool_name).toBe("shell");
      expect(call?.text).toContain("tests/parser");

      const output = entries[3];
      expect(output?.tool_name).toBe("shell");
      expect(output?.text).toContain("parser test passed");
    });
  });
});

describe("OpenCode adapter", () => {
  test("解析 session_v2 與 session_message 的文字與工具", async () => {
    await withTranscriptEnv("adapter-opencode-v2", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      createOpencodeV2Database(
        dbPath,
        [{ id: "ses_fixture_1", directory: "/work/gamma", timeUpdated: baseTime + 5_000 }],
        [
          {
            id: "msg_user_1",
            sessionId: "ses_fixture_1",
            type: "user",
            seq: 1,
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { text: "Please inspect the queue flush behavior.", time: { created: baseTime } },
          },
          {
            id: "msg_assistant_1",
            sessionId: "ses_fixture_1",
            type: "assistant",
            seq: 2,
            timeCreated: baseTime + 1_000,
            timeUpdated: baseTime + 2_000,
            data: {
              content: [
                { type: "text", text: "The queue flush returns too early." },
                {
                  type: "tool",
                  name: "read",
                  state: {
                    input: { file_path: "src/queue.ts" },
                    content: [{ type: "text", text: "function flush() {}" }],
                    output: "old output should lose",
                  },
                },
              ],
              time: { created: baseTime + 1_000 },
            },
          },
          {
            id: "msg_user_2",
            sessionId: "ses_fixture_1",
            type: "user",
            seq: 3,
            timeCreated: baseTime + 3_000,
            timeUpdated: baseTime + 3_000,
            data: { text: "Fix the flush ordering.", time: { created: baseTime + 3_000 } },
          },
          {
            id: "msg_assistant_2",
            sessionId: "ses_fixture_1",
            type: "assistant",
            seq: 4,
            timeCreated: baseTime + 4_000,
            timeUpdated: baseTime + 4_000,
            data: {
              content: [{ type: "text", text: "Flush now waits for the queue." }],
              time: { created: baseTime + 4_000 },
            },
          },
        ],
      );

      const env = {
        ...context.env,
        SMILEWORK_OPENCODE_DB: dbPath,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex",
      };
      const report = buildTranscriptIndex({ env, dbPath: context.dbPath });
      expect(report.opencode.changedMessages).toBe(4);

      const entries = readIndexEntries(context.dbPath, "opencode:ses_fixture_1");
      expect(entries.map((entry) => entry.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
      ]);
      expect(entries.map((entry) => entry.turn)).toEqual([1, 1, 1, 2, 2]);
      expect(entries.every((entry) => entry.project_path === "/work/gamma")).toBe(true);
      expect(entries[0]?.at).toBe("2026-11-01T12:00:00.000Z");
      expect(entries[2]?.tool_name).toBe("read");
      expect(entries[2]?.text).toContain("function flush()");
      expect(entries[2]?.text).not.toContain("old output should lose");

      const searched = searchTranscripts(
        { query: "function flush" },
        { env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(searched.ok).toBe(true);
      if (!searched.ok) return;
      const hits = (searched.data as { results: { toolName?: string; text: string }[] }).results;
      expect(hits).toHaveLength(1);
      expect(hits[0]?.toolName).toBe("read");
      expect(hits[0]?.text.replace(/\[|\]/g, "")).toContain("function flush");

      const read = readTranscriptSession(
        { sessionRef: "opencode:ses_fixture_1" },
        { env, dbPath: context.dbPath },
      );
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const readEntries = (read.data as { entries: { text: string; toolName?: string }[] }).entries;
      expect(readEntries.some((entry) => entry.text.includes("function flush()"))).toBe(true);
    });
  });

  test("session_v2 的舊 state.output 格式仍可解析", async () => {
    await withTranscriptEnv("adapter-opencode-output", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      createOpencodeV2Database(
        dbPath,
        [{ id: "ses_output", directory: "/work/gamma", timeUpdated: baseTime + 2_000 }],
        [
          {
            id: "msg_output_user",
            sessionId: "ses_output",
            type: "user",
            seq: 1,
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { text: "Run the old tool output.", time: { created: baseTime } },
          },
          {
            id: "msg_output_assistant",
            sessionId: "ses_output",
            type: "assistant",
            seq: 2,
            timeCreated: baseTime + 1_000,
            timeUpdated: baseTime + 2_000,
            data: {
              content: [
                {
                  type: "tool",
                  name: "bash",
                  state: {
                    input: { command: "pwd" },
                    output: "legacy output marker",
                  },
                },
              ],
              time: { created: baseTime + 1_000 },
            },
          },
        ],
      );

      const env = {
        ...context.env,
        SMILEWORK_OPENCODE_DB: dbPath,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const entries = readIndexEntries(context.dbPath, "opencode:ses_output");
      expect(entries.map((entry) => entry.text)).toContain("legacy output marker");
    });
  });

  test("相容舊版 session/message/part 資料表", async () => {
    await withTranscriptEnv("adapter-opencode-v1", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      createOpencodeV1Database(dbPath, {
        session: { id: "ses_legacy_1", directory: "/work/legacy", timeUpdated: baseTime + 2_000 },
        messages: [
          {
            id: "msg_legacy_user",
            role: "user",
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { role: "user", time: { created: baseTime } },
            parts: [
              {
                id: "part_user_text",
                type: "text",
                timeCreated: baseTime,
                timeUpdated: baseTime,
                data: { type: "text", text: "Legacy user message." },
              },
            ],
          },
          {
            id: "msg_legacy_assistant",
            role: "assistant",
            timeCreated: baseTime + 1_000,
            timeUpdated: baseTime + 2_000,
            data: { role: "assistant", time: { created: baseTime + 1_000 } },
            parts: [
              {
                id: "part_assistant_text",
                type: "text",
                timeCreated: baseTime + 1_000,
                timeUpdated: baseTime + 1_000,
                data: { type: "text", text: "Legacy assistant message." },
              },
              {
                id: "part_assistant_tool",
                type: "tool",
                timeCreated: baseTime + 2_000,
                timeUpdated: baseTime + 2_000,
                data: {
                  type: "tool",
                  tool: "bash",
                  state: { input: { command: "ls" }, output: "file.txt" },
                },
              },
            ],
          },
        ],
      });

      const env = {
        ...context.env,
        SMILEWORK_OPENCODE_DB: dbPath,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const entries = readIndexEntries(context.dbPath, "opencode:ses_legacy_1");
      expect(entries.map((entry) => entry.text)).toEqual([
        "Legacy user message.",
        "Legacy assistant message.",
        "file.txt",
      ]);
      expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant", "tool"]);
      expect(entries[2]?.tool_name).toBe("bash");
    });
  });
});
