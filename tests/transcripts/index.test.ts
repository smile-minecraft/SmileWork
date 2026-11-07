import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTranscriptIndex } from "../../src/transcripts/indexer.ts";
import { acquireBuildLock, isBuildLockActive } from "../../src/transcripts/lock.ts";
import { searchTranscripts } from "../../src/transcripts/search.ts";
import {
  appendJsonl,
  appendOpencodeMessages,
  claudeAssistant,
  claudeUser,
  countTableRows,
  createOpencodeV2Database,
  deleteOpencodeMessage,
  fixturePath,
  insertRawOpencodeMessage,
  readIndexEntries,
  readIndexWarnings,
  updateOpencodeMessage,
  withTranscriptEnv,
  writeClaudeJsonl,
  writeCodexJsonl,
} from "./helpers.ts";

describe("增量索引", () => {
  test("新增一行只補新資料，不重複索引", async () => {
    await withTranscriptEnv("incremental-jsonl", async (context) => {
      const file = await writeClaudeJsonl(context.fakeHome, "incremental.jsonl", [
        claudeUser("first message about the queue"),
        claudeAssistant("second message about the flush"),
      ]);

      const first = buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(first.files[0]?.parsedLines).toBe(2);
      expect(first.files[0]?.addedEntries).toBe(2);
      expect(first.totals.entries).toBe(2);

      await appendJsonl(file, [
        claudeUser("third message about retry", {
          timestamp: "2026-11-01T12:05:00.000Z",
        }),
      ]);

      const second = buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(second.files[0]?.reset).toBe(false);
      expect(second.files[0]?.parsedLines).toBe(1);
      expect(second.files[0]?.fromOffset).toBeGreaterThan(0);
      expect(second.files[0]?.addedEntries).toBe(1);
      expect(second.totals.entries).toBe(3);

      const entries = readIndexEntries(context.dbPath);
      expect(entries.map((entry) => entry.text)).toEqual([
        "first message about the queue",
        "second message about the flush",
        "third message about retry",
      ]);
      expect(new Set(entries.map((entry) => entry.entry_id)).size).toBe(3);

      const third = buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(third.files[0]?.parsedLines).toBe(0);
      expect(third.files[0]?.addedEntries).toBe(0);
      expect(third.totals.entries).toBe(3);
      expect(existsSync(context.dbPath)).toBe(true);
      expect(statSync(context.dbPath).mode & 0o777).toBe(0o600);
    });
  });

  test("殘留的鎖檔（程序已結束）可以接手", async () => {
    await withTranscriptEnv("build-lock-stale", async (context) => {
      const lockPath = `${context.dbPath}.build.lock`;
      mkdirSync(context.home, { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({ token: "stale", pid: 999_999, startedAt: Date.now() }),
      );

      const lock = acquireBuildLock(lockPath);
      expect(lock).not.toBeNull();
      lock?.release();
    });
  });

  test("rebuild 清空索引後重建，不會留下重複資料", async () => {
    await withTranscriptEnv("rebuild", async (context) => {
      await writeClaudeJsonl(context.fakeHome, "rebuild.jsonl", [
        claudeUser("rebuild message one"),
        claudeAssistant("rebuild message two"),
      ]);
      buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(readIndexEntries(context.dbPath)).toHaveLength(2);

      const rebuilt = buildTranscriptIndex({
        env: context.env,
        dbPath: context.dbPath,
        rebuild: true,
      });
      expect(rebuilt.files.every((file) => file.reset)).toBe(true);
      expect(rebuilt.totals.entries).toBe(2);
      expect(readIndexEntries(context.dbPath)).toHaveLength(2);

      const searched = searchTranscripts(
        { query: "rebuild message" },
        { env: context.env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(searched.ok).toBe(true);
      if (!searched.ok) return;
      expect((searched.data as { results: unknown[] }).results).toHaveLength(2);
    });
  });

  test("同一時間只有一個 builder 能取得鎖", async () => {
    await withTranscriptEnv("build-lock", async (context) => {
      const lockPath = `${context.dbPath}.build.lock`;
      const lock = acquireBuildLock(lockPath);
      expect(lock).not.toBeNull();
      expect(isBuildLockActive(lockPath)).toBe(true);

      const blocked = buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(blocked.skipped).toBe(true);
      expect(blocked.reason).toBe("locked");
      expect(blocked.totals.entries).toBe(0);

      lock?.release();
      expect(isBuildLockActive(lockPath)).toBe(false);

      const built = buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(built.skipped).toBe(false);
      expect(built.reason).toBeNull();
    });
  });
});

describe("警告與來源設定", () => {
  test("讀不懂的格式不中斷其他來源", async () => {
    await withTranscriptEnv("unknown-source", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_CODEX_SESSIONS_DIR: fixturePath("codex"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "opencode",
      };
      const report = buildTranscriptIndex({ env, dbPath: context.dbPath });
      expect(report.errors).toEqual([]);

      const codexEntries = readIndexEntries(context.dbPath, "codex:codex-fixture-1");
      expect(codexEntries.length).toBeGreaterThan(0);

      const warnings = readIndexWarnings(context.dbPath);
      expect(warnings.some((warning) => warning.message.includes("不是有效的 JSON 行"))).toBe(true);
      expect(report.warnings.some((warning) => warning.source === "claude")).toBe(true);
    });
  });

  test("關閉來源與排除專案路徑都不會進索引", async () => {
    await withTranscriptEnv("source-settings", async (context) => {
      await writeClaudeJsonl(context.fakeHome, "claude.jsonl", [
        claudeUser("alpha project message", { cwd: "/work/alpha" }),
      ]);
      await writeCodexJsonl(context.fakeHome, "codex.jsonl", [
        {
          timestamp: "2026-11-02T09:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-settings-1", cwd: "/work/beta" },
        },
        {
          timestamp: "2026-11-02T09:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "beta project message" }],
          },
        },
      ]);

      const disabledEnv = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex",
      };
      buildTranscriptIndex({ env: disabledEnv, dbPath: context.dbPath });
      expect(readIndexEntries(context.dbPath).some((entry) => entry.source === "codex")).toBe(
        false,
      );

      const excludedEnv = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS: "/work/alpha",
      };
      buildTranscriptIndex({ env: excludedEnv, dbPath: context.dbPath });
      const entries = readIndexEntries(context.dbPath);
      expect(entries.some((entry) => entry.project_path === "/work/alpha")).toBe(false);
      expect(entries.some((entry) => entry.project_path === "/work/beta")).toBe(true);
    });
  });
  test("關閉來源或新排除專案時會清掉既有索引", async () => {
    await withTranscriptEnv("source-cleanup", async (context) => {
      await writeClaudeJsonl(context.fakeHome, "claude.jsonl", [
        claudeUser("alpha cleanup message", { cwd: "/work/alpha" }),
      ]);
      await writeCodexJsonl(context.fakeHome, "codex.jsonl", [
        {
          timestamp: "2026-11-02T09:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-cleanup-1", cwd: "/work/beta" },
        },
        {
          timestamp: "2026-11-02T09:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "beta cleanup message" }],
          },
        },
      ]);

      buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      expect(countTableRows(context.dbPath, "entries", "claude")).toBe(1);
      expect(countTableRows(context.dbPath, "entries", "codex")).toBe(1);

      const disabledEnv = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude",
      };
      buildTranscriptIndex({ env: disabledEnv, dbPath: context.dbPath });
      expect(countTableRows(context.dbPath, "entries", "claude")).toBe(0);
      expect(countTableRows(context.dbPath, "source_files", "claude")).toBe(0);
      expect(countTableRows(context.dbPath, "sessions", "claude")).toBe(0);
      expect(countTableRows(context.dbPath, "entries", "codex")).toBe(1);

      const excludedEnv = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS: "/work/beta",
      };
      buildTranscriptIndex({ env: excludedEnv, dbPath: context.dbPath });
      expect(countTableRows(context.dbPath, "entries", "codex")).toBe(0);
      expect(countTableRows(context.dbPath, "source_files", "codex")).toBe(0);
    });
  });
});

describe("機密遮蔽", () => {
  test("索引前就把疑似機密換成 [REDACTED]，搜尋結果也看不到原始值", async () => {
    await withTranscriptEnv("secrets", async (context) => {
      const fakeToken = `sk-test-${"a".repeat(24)}`;
      await writeClaudeJsonl(context.fakeHome, "secret.jsonl", [
        claudeUser(`deploy with api_key = "${fakeToken}" and keep going`),
      ]);

      buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });
      const entries = readIndexEntries(context.dbPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toContain("[REDACTED]");
      expect(entries[0]?.text).not.toContain(fakeToken);

      const result = searchTranscripts(
        { query: "deploy" },
        { env: context.env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { results: { text: string }[] };
      expect(data.results.length).toBe(1);
      expect(data.results[0]?.text).not.toContain(fakeToken);

      const redacted = searchTranscripts(
        { query: "REDACTED" },
        { env: context.env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(redacted.ok).toBe(true);
      if (!redacted.ok) return;
      const redactedData = redacted.data as { results: { text: string }[] };
      expect(redactedData.results.length).toBe(1);
      expect(redactedData.results[0]?.text).toContain("[REDACTED]");
      expect(redactedData.results[0]?.text).not.toContain(fakeToken);
    });
  });
});

describe("OpenCode 增量索引", () => {
  test("只補新訊息，訊息更新後取代舊內容", async () => {
    await withTranscriptEnv("opencode-incremental", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      const baseTime = Date.parse("2026-11-03T08:00:00.000Z");
      createOpencodeV2Database(
        dbPath,
        [{ id: "ses_incremental", directory: "/work/gamma", timeUpdated: baseTime }],
        [
          {
            id: "msg_user",
            sessionId: "ses_incremental",
            type: "user",
            seq: 1,
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { text: "First user message.", time: { created: baseTime } },
          },
        ],
      );

      const env = {
        ...context.env,
        SMILEWORK_OPENCODE_DB: dbPath,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex",
      };

      const first = buildTranscriptIndex({ env, dbPath: context.dbPath });
      expect(first.opencode.changedMessages).toBe(1);
      expect(readIndexEntries(context.dbPath, "opencode:ses_incremental")).toHaveLength(1);

      appendOpencodeMessages(
        dbPath,
        [
          {
            id: "msg_assistant",
            sessionId: "ses_incremental",
            type: "assistant",
            seq: 2,
            timeCreated: baseTime + 1_000,
            timeUpdated: baseTime + 1_000,
            data: {
              content: [{ type: "text", text: "First assistant message." }],
              time: { created: baseTime + 1_000 },
            },
          },
        ],
        { sessionId: "ses_incremental", timeUpdated: baseTime + 1_000 },
      );

      const second = buildTranscriptIndex({ env, dbPath: context.dbPath });
      expect(second.opencode.changedMessages).toBe(1);
      expect(readIndexEntries(context.dbPath, "opencode:ses_incremental")).toHaveLength(2);

      updateOpencodeMessage(
        dbPath,
        "msg_assistant",
        {
          content: [{ type: "text", text: "Updated assistant message." }],
          time: { created: baseTime + 1_000 },
        },
        baseTime + 2_000,
        "ses_incremental",
      );

      const third = buildTranscriptIndex({ env, dbPath: context.dbPath });
      expect(third.opencode.changedMessages).toBe(1);
      const entries = readIndexEntries(context.dbPath, "opencode:ses_incremental");
      expect(entries.map((entry) => entry.text)).toEqual([
        "First user message.",
        "Updated assistant message.",
      ]);
      expect(entries.some((entry) => entry.text.includes("First assistant message."))).toBe(
        false,
      );

      const oldText = searchTranscripts(
        { query: "First assistant message" },
        { env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(oldText.ok).toBe(true);
      if (!oldText.ok) return;
      expect((oldText.data as { results: unknown[] }).results).toHaveLength(0);

      const newText = searchTranscripts(
        { query: "Updated assistant message" },
        { env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(newText.ok).toBe(true);
      if (!newText.ok) return;
      expect((newText.data as { results: unknown[] }).results).toHaveLength(1);
    });
  });

  test("讀不懂的 OpenCode 訊息會寫進 warnings 表並出現在搜尋結果", async () => {
    await withTranscriptEnv("opencode-warning", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      const baseTime = Date.parse("2026-11-04T08:00:00.000Z");
      createOpencodeV2Database(
        dbPath,
        [{ id: "ses_warning", directory: "/work/warning", timeUpdated: baseTime }],
        [
          {
            id: "msg_valid",
            sessionId: "ses_warning",
            type: "user",
            seq: 1,
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { text: "valid user message", time: { created: baseTime } },
          },
        ],
      );
      insertRawOpencodeMessage(dbPath, {
        id: "msg_bad",
        sessionId: "ses_warning",
        type: "user",
        seq: 2,
        timeCreated: baseTime + 1_000,
        timeUpdated: baseTime + 1_000,
        rawData: "{not valid json",
      });

      const env = {
        ...context.env,
        SMILEWORK_OPENCODE_DB: dbPath,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const warnings = readIndexWarnings(context.dbPath);
      const opencodeWarning = warnings.find(
        (warning) =>
          warning.source === "opencode" &&
          warning.message === "OpenCode 訊息內容不是有效的 JSON",
      );
      expect(opencodeWarning).toBeDefined();

      const searched = searchTranscripts(
        { query: "valid user message" },
        { env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(searched.ok).toBe(true);
      if (!searched.ok) return;
      const data = searched.data as {
        results: unknown[];
        warnings: { source: string; message: string }[];
      };
      expect(data.results.length).toBeGreaterThanOrEqual(1);
      expect(
        data.warnings.some(
          (warning) =>
            warning.source === "opencode" &&
            warning.message === "OpenCode 訊息內容不是有效的 JSON",
        ),
      ).toBe(true);
    });
  });

  test("刪除個別 OpenCode 訊息後不再命中", async () => {
    await withTranscriptEnv("opencode-deleted-message", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      const baseTime = Date.parse("2026-11-05T08:00:00.000Z");
      createOpencodeV2Database(
        dbPath,
        [{ id: "ses_delete", directory: "/work/delete", timeUpdated: baseTime + 1_000 }],
        [
          {
            id: "msg_keep",
            sessionId: "ses_delete",
            type: "user",
            seq: 1,
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { text: "keep user message", time: { created: baseTime } },
          },
          {
            id: "msg_remove",
            sessionId: "ses_delete",
            type: "assistant",
            seq: 2,
            timeCreated: baseTime + 1_000,
            timeUpdated: baseTime + 1_000,
            data: {
              content: [{ type: "text", text: "deleted assistant marker" }],
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
      expect(readIndexEntries(context.dbPath, "opencode:ses_delete")).toHaveLength(2);

      deleteOpencodeMessage(dbPath, "msg_remove", "ses_delete", baseTime + 1_000);
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const entries = readIndexEntries(context.dbPath, "opencode:ses_delete");
      expect(entries.map((entry) => entry.text)).toEqual(["keep user message"]);

      const searched = searchTranscripts(
        { query: "deleted assistant marker" },
        { env, dbPath: context.dbPath, autoIndex: false },
      );
      expect(searched.ok).toBe(true);
      if (!searched.ok) return;
      expect((searched.data as { results: unknown[] }).results).toHaveLength(0);
    });
  });
});
