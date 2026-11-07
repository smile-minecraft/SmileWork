import { describe, expect, test } from "bun:test";
import { buildTranscriptIndex } from "../../src/transcripts/indexer.ts";
import { readTranscriptSession } from "../../src/transcripts/read.ts";
import { SmileworkError } from "../../src/shared/errors.ts";
import {
  claudeUser,
  fixturePath,
  withTranscriptEnv,
  writeClaudeJsonl,
  type TranscriptTestContext,
} from "./helpers.ts";

interface ReadData {
  sessionRef: string;
  source: string;
  projectPath: string | null;
  entries: { turn: number; role: string; text: string; toolName?: string; at?: string }[];
  returnedChars: number;
  truncated: boolean;
  truncatedBy: "turns" | "chars" | "rows" | null;
  nextTurn: number | null;
}

function buildFixtures(context: TranscriptTestContext): NodeJS.ProcessEnv {
  const env = {
    ...context.env,
    SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
    SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
  };
  buildTranscriptIndex({ env, dbPath: context.dbPath });
  return env;
}

describe("讀取對話", () => {
  test("maxTurns 限制回合數並回報下一個回合", async () => {
    await withTranscriptEnv("read-turns", async (context) => {
      const env = buildFixtures(context);
      const result = readTranscriptSession(
        { sessionRef: "claude:claude-fixture-1", maxTurns: 1 },
        { env, dbPath: context.dbPath },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as ReadData;
      expect(data.entries.every((entry) => entry.turn === 1)).toBe(true);
      expect(data.entries).toHaveLength(5);
      expect(data.truncated).toBe(true);
      expect(data.truncatedBy).toBe("turns");
      expect(data.nextTurn).toBe(2);
      expect(data.projectPath).toBe("/work/alpha");
    });
  });

  test("fromTurn 只回傳指定回合之後的內容", async () => {
    await withTranscriptEnv("read-from-turn", async (context) => {
      const env = buildFixtures(context);
      const result = readTranscriptSession(
        { sessionRef: "claude:claude-fixture-1", fromTurn: 2 },
        { env, dbPath: context.dbPath },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as ReadData;
      expect(data.entries).toHaveLength(2);
      expect(data.entries.every((entry) => entry.turn === 2)).toBe(true);
      expect(data.truncated).toBe(false);

      const beyond = readTranscriptSession(
        { sessionRef: "claude:claude-fixture-1", fromTurn: 99 },
        { env, dbPath: context.dbPath },
      );
      expect(beyond.ok).toBe(true);
      if (!beyond.ok) return;
      expect((beyond.data as ReadData).entries).toHaveLength(0);
    });
  });

  test("maxChars 限制文字總長並截斷單筆內容", async () => {
    await withTranscriptEnv("read-chars", async (context) => {
      const env = buildFixtures(context);
      const result = readTranscriptSession(
        { sessionRef: "claude:claude-fixture-1", maxTurns: 5, maxChars: 100 },
        { env, dbPath: context.dbPath },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as ReadData;
      expect(data.returnedChars).toBeLessThanOrEqual(100);
      expect(data.truncated).toBe(true);
      expect(data.truncatedBy).toBe("chars");
      const total = data.entries.reduce((sum, entry) => sum + Array.from(entry.text).length, 0);
      expect(total).toBeLessThanOrEqual(100);
    });
  });

  test("找不到對話與無效參數都有明確錯誤", async () => {
    await withTranscriptEnv("read-errors", async (context) => {
      const env = buildFixtures(context);

      let missing: unknown;
      try {
        readTranscriptSession(
          { sessionRef: "claude:not-found" },
          { env, dbPath: context.dbPath },
        );
      } catch (error) {
        missing = error;
      }
      expect(missing).toBeInstanceOf(SmileworkError);
      expect((missing as SmileworkError).code).toBe("NOT_FOUND");

      let invalid: unknown;
      try {
        readTranscriptSession(
          { sessionRef: "claude:claude-fixture-1", maxTurns: 0 },
          { env, dbPath: context.dbPath },
        );
      } catch (error) {
        invalid = error;
      }
      expect(invalid).toBeInstanceOf(SmileworkError);
      expect((invalid as SmileworkError).code).toBe("INVALID_INPUT");
    });
  });

  test("來源關閉時拒絕讀取", async () => {
    await withTranscriptEnv("read-source-disabled", async (context) => {
      buildFixtures(context);
      const disabledEnv = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude",
      };

      let error: unknown;
      try {
        readTranscriptSession(
          { sessionRef: "claude:claude-fixture-1" },
          { env: disabledEnv, dbPath: context.dbPath },
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(SmileworkError);
      const failure = error as SmileworkError;
      expect(failure.code).toBe("TRANSCRIPT_SOURCE_DISABLED");
      expect(failure.nextAction).toContain("claude");
      expect(JSON.stringify(failure.data)).not.toContain("timeout behavior");
    });
  });

  test("專案被排除時拒絕讀取", async () => {
    await withTranscriptEnv("read-project-excluded", async (context) => {
      buildFixtures(context);
      const excludedEnv = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS: "/work/alpha",
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };

      let error: unknown;
      try {
        readTranscriptSession(
          { sessionRef: "claude:claude-fixture-1" },
          { env: excludedEnv, dbPath: context.dbPath },
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(SmileworkError);
      const failure = error as SmileworkError;
      expect(failure.code).toBe("TRANSCRIPT_PROJECT_EXCLUDED");
      expect(failure.nextAction).toContain("排除");
      expect(JSON.stringify(failure.data)).not.toContain("timeout behavior");

      buildTranscriptIndex({ env: excludedEnv, dbPath: context.dbPath });
      let afterRebuild: unknown;
      try {
        readTranscriptSession(
          { sessionRef: "claude:claude-fixture-1" },
          { env: excludedEnv, dbPath: context.dbPath },
        );
      } catch (caught) {
        afterRebuild = caught;
      }
      expect(afterRebuild).toBeInstanceOf(SmileworkError);
      expect((afterRebuild as SmileworkError).code).toBe("TRANSCRIPT_PROJECT_EXCLUDED");
    });
  });

  test("第一次建索引就排除專案也能拒絕讀取", async () => {
    await withTranscriptEnv("read-project-excluded-first", async (context) => {
      const excludedEnv = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS: "/work/alpha",
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };
      buildTranscriptIndex({ env: excludedEnv, dbPath: context.dbPath });

      let error: unknown;
      try {
        readTranscriptSession(
          { sessionRef: "claude:claude-fixture-1" },
          { env: excludedEnv, dbPath: context.dbPath },
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SmileworkError);
      expect((error as SmileworkError).code).toBe("TRANSCRIPT_PROJECT_EXCLUDED");
    });
  });

  test("讀取時也只看到已遮蔽的機密", async () => {
    await withTranscriptEnv("read-secrets", async (context) => {
      const fakeToken = `ghp_${"b".repeat(24)}`;
      await writeClaudeJsonl(context.fakeHome, "secret.jsonl", [
        claudeUser(`token is ${fakeToken} for the deploy`, { sessionId: "claude-secret-1" }),
      ]);
      buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });

      const result = readTranscriptSession(
        { sessionRef: "claude:claude-secret-1" },
        { env: context.env, dbPath: context.dbPath },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as ReadData;
      expect(data.entries[0]?.text).toContain("[REDACTED]");
      expect(data.entries[0]?.text).not.toContain(fakeToken);
    });
  });
});
