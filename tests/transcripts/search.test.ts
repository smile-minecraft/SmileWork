import { describe, expect, test } from "bun:test";
import { openTranscriptIndex } from "../../src/transcripts/index-db.ts";
import { buildTranscriptIndex } from "../../src/transcripts/indexer.ts";
import { acquireBuildLock, buildLockPath, isBuildLockActive } from "../../src/transcripts/lock.ts";
import { searchTranscripts } from "../../src/transcripts/search.ts";
import { SmileworkError } from "../../src/shared/errors.ts";
import {
  claudeUser,
  fixturePath,
  withTranscriptEnv,
  writeClaudeJsonl,
  type TranscriptTestContext,
} from "./helpers.ts";

interface SearchData {
  count: number;
  results: {
    source: string;
    sessionRef: string;
    projectPath?: string;
    turn: number;
    role: string;
    text: string;
    toolName?: string;
    at?: string;
  }[];
  hasMore: boolean;
  indexing: boolean;
  index: { ready: boolean; building: boolean; started: boolean };
  warnings: { source: string; message: string; occurrences: number }[];
}

function buildFixtures(context: TranscriptTestContext) {
  const env = {
    ...context.env,
    SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
    SMILEWORK_CODEX_SESSIONS_DIR: fixturePath("codex"),
    SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "opencode",
  };
  buildTranscriptIndex({ env, dbPath: context.dbPath });
  return env;
}

function search(
  context: TranscriptTestContext,
  env: NodeJS.ProcessEnv,
  input: Parameters<typeof searchTranscripts>[0],
) {
  return searchTranscripts(input, { env, dbPath: context.dbPath, autoIndex: false });
}

describe("對話搜尋", () => {
  test("中文用 trigram 命中 3 個字以上，2 個字時退回子字串比對", async () => {
    await withTranscriptEnv("search-chinese", async (context) => {
      const env = buildFixtures(context);

      const phrase = search(context, env, { query: "結案條件" });
      expect(phrase.ok).toBe(true);
      if (!phrase.ok) return;
      const phraseData = phrase.data as SearchData;
      expect(phraseData.results.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(phraseData.results)).toContain("結案條件");

      const short = search(context, env, { query: "證據" });
      expect(short.ok).toBe(true);
      if (!short.ok) return;
      const shortData = short.data as SearchData;
      expect(shortData.results.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(shortData.results)).toContain("證據");

      const mixed = search(context, env, { query: "證據 timeout" });
      expect(mixed.ok).toBe(true);
      if (!mixed.ok) return;
      const mixedData = mixed.data as SearchData;
      expect(mixedData.results.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(mixedData.results)).toContain("證據");
      expect(JSON.stringify(mixedData.results)).toContain("timeout");
    });
  });

  test("混合長短 token 會逐 token 比對", async () => {
    await withTranscriptEnv("search-mixed-tokens", async (context) => {
      await writeClaudeJsonl(context.fakeHome, "mixed.jsonl", [
        claudeUser("timeout behavior go check", { sessionId: "claude-mixed-1" }),
      ]);
      buildTranscriptIndex({ env: context.env, dbPath: context.dbPath });

      for (const query of ["timeout go", "go check", "go"]) {
        const result = search(context, context.env, { query });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect((result.data as SearchData).results.length).toBeGreaterThanOrEqual(1);
      }

      const missing = search(context, context.env, { query: "timeout missing" });
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect((missing.data as SearchData).results).toHaveLength(0);
    });
  });

  test("英文查詢、limit 與來源篩選", async () => {
    await withTranscriptEnv("search-english", async (context) => {
      const env = buildFixtures(context);

      const limited = search(context, env, { query: "timeout", limit: 2 });
      expect(limited.ok).toBe(true);
      if (!limited.ok) return;
      const limitedData = limited.data as SearchData;
      expect(limitedData.results).toHaveLength(2);
      expect(limitedData.hasMore).toBe(true);
      expect(limitedData.results.every((hit) => hit.text.length <= 400)).toBe(true);

      const codex = search(context, env, { query: "flaky" });
      expect(codex.ok).toBe(true);
      if (!codex.ok) return;
      const codexData = codex.data as SearchData;
      expect(codexData.results.length).toBeGreaterThanOrEqual(1);
      expect(codexData.results.every((hit) => hit.source === "codex")).toBe(true);

      const wrongSource = search(context, env, { query: "flaky", source: "claude" });
      expect(wrongSource.ok).toBe(true);
      if (!wrongSource.ok) return;
      expect((wrongSource.data as SearchData).results).toHaveLength(0);
    });
  });

  test("since 與 project 篩選", async () => {
    await withTranscriptEnv("search-filters", async (context) => {
      const env = buildFixtures(context);

      const before = search(context, env, { query: "timeout", since: "2026-11-02" });
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect((before.data as SearchData).results).toHaveLength(0);

      const after = search(context, env, { query: "timeout", since: "2026-10-31" });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect((after.data as SearchData).results.length).toBeGreaterThan(0);

      const alpha = search(context, env, { query: "timeout", project: "/work/alpha" });
      expect(alpha.ok).toBe(true);
      if (!alpha.ok) return;
      expect((alpha.data as SearchData).results.length).toBeGreaterThan(0);

      const beta = search(context, env, { query: "timeout", project: "/work/beta" });
      expect(beta.ok).toBe(true);
      if (!beta.ok) return;
      expect((beta.data as SearchData).results).toHaveLength(0);

      const excludedEnv = {
        ...env,
        SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS: "/work/alpha",
      };
      const excluded = search(context, excludedEnv, { query: "timeout" });
      expect(excluded.ok).toBe(true);
      if (!excluded.ok) return;
      expect((excluded.data as SearchData).results).toHaveLength(0);

      const otherProject = search(context, excludedEnv, { query: "flaky" });
      expect(otherProject.ok).toBe(true);
      if (!otherProject.ok) return;
      expect((otherProject.data as SearchData).results.length).toBeGreaterThan(0);
    });
  });

  test("關閉的來源不會被搜尋", async () => {
    await withTranscriptEnv("search-disabled", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_CODEX_SESSIONS_DIR: fixturePath("codex"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const result = search(context, env, { query: "flaky", source: "codex" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.data as SearchData).results).toHaveLength(0);
    });
  });

  test("無效參數回傳明確錯誤", async () => {
    await withTranscriptEnv("search-invalid", async (context) => {
      const env = buildFixtures(context);

      for (const input of [{ query: "  " }, { query: "timeout", limit: 0 }]) {
        let error: unknown;
        try {
          search(context, env, input);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(SmileworkError);
        expect((error as SmileworkError).code).toBe("INVALID_INPUT");
      }
    });
  });
});

describe("第一次搜尋才建立索引", () => {
  test("索引不存在時啟動背景 builder，而且同一個時間只啟動一次", async () => {
    await withTranscriptEnv("search-bootstrap", async (context) => {
      const lockPath = buildLockPath(context.dbPath);
      const locks: { release(): void }[] = [];
      let starts = 0;
      const startBuilder = (): boolean => {
        starts += 1;
        const lock = acquireBuildLock(lockPath);
        if (!lock) return false;
        locks.push(lock);
        return true;
      };

      const first = searchTranscripts(
        { query: "anything" },
        {
          env: context.env,
          dbPath: context.dbPath,
          autoIndex: true,
          refreshMs: 0,
          startBuilder,
        },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const firstData = first.data as SearchData;
      expect(firstData.index.ready).toBe(false);
      expect(firstData.index.started).toBe(true);
      expect(firstData.index.building).toBe(true);
      expect(firstData.indexing).toBe(true);
      expect(firstData.results).toHaveLength(0);
      expect(first.summary).toContain("建立");

      const second = searchTranscripts(
        { query: "anything" },
        {
          env: context.env,
          dbPath: context.dbPath,
          autoIndex: true,
          refreshMs: 0,
          startBuilder,
        },
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect((second.data as SearchData).index.building).toBe(true);
      expect((second.data as SearchData).indexing).toBe(true);
      expect(starts).toBe(1);
      expect(isBuildLockActive(lockPath)).toBe(true);

      for (const lock of locks) lock.release();
    });
  });

  test("只建好 schema、還沒完成第一次索引時不算 ready", async () => {
    await withTranscriptEnv("search-incomplete", async (context) => {
      openTranscriptIndex(context.dbPath).close();
      let starts = 0;
      const result = searchTranscripts(
        { query: "anything" },
        {
          env: context.env,
          dbPath: context.dbPath,
          autoIndex: true,
          refreshMs: 0,
          startBuilder: () => {
            starts += 1;
            return true;
          },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as SearchData;
      expect(data.index.ready).toBe(false);
      expect(data.indexing).toBe(true);
      expect(data.index.started).toBe(true);
      expect(data.results).toHaveLength(0);
      expect(result.summary).toContain("建立");
      expect(starts).toBe(1);
    });
  });

  test("來源設定變動會觸發重建，即使還沒到刷新時間", async () => {
    await withTranscriptEnv("search-config-change", async (context) => {
      const disabledEnv = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex,opencode",
      };
      buildTranscriptIndex({ env: disabledEnv, dbPath: context.dbPath });

      let starts = 0;
      const result = searchTranscripts(
        { query: "anything" },
        {
          env: context.env,
          dbPath: context.dbPath,
          autoIndex: true,
          refreshMs: 999_999,
          startBuilder: () => {
            starts += 1;
            return true;
          },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as SearchData;
      expect(data.index.ready).toBe(true);
      expect(data.index.started).toBe(true);
      expect(data.indexing).toBe(false);
      expect(starts).toBe(1);
    });
  });

  test("索引過期時會再啟動一次增量建立", async () => {
    await withTranscriptEnv("search-refresh", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex,opencode",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });
      let starts = 0;
      const result = searchTranscripts(
        { query: "anything" },
        {
          env,
          dbPath: context.dbPath,
          autoIndex: true,
          refreshMs: 0,
          startBuilder: () => {
            starts += 1;
            return true;
          },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.data as SearchData).index.ready).toBe(true);
      expect((result.data as SearchData).index.started).toBe(true);
      expect((result.data as SearchData).indexing).toBe(false);
      expect(starts).toBe(1);
    });
  });
});
