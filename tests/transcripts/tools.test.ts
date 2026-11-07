import { describe, expect, test } from "bun:test";
import { buildTranscriptIndex } from "../../src/transcripts/indexer.ts";
import { createTranscriptReadHandler, tool as readTool, transcriptReadSchema } from "../../src/tools/transcript/read.ts";
import {
  createTranscriptSearchHandler,
  tool as searchTool,
  transcriptSearchSchema,
} from "../../src/tools/transcript/search.ts";
import { fixturePath, withTranscriptEnv } from "./helpers.ts";

describe("transcript_search 工具", () => {
  test("輸入 schema 限制 query 與 limit", () => {
    expect(transcriptSearchSchema.safeParse({ query: "timeout" }).success).toBe(true);
    expect(transcriptSearchSchema.safeParse({ query: "" }).success).toBe(false);
    expect(transcriptSearchSchema.safeParse({ query: "timeout", limit: 0 }).success).toBe(false);
    expect(transcriptSearchSchema.safeParse({ query: "timeout", limit: 51 }).success).toBe(false);
    expect(transcriptSearchSchema.safeParse({ query: "timeout", source: "other" }).success).toBe(
      false,
    );
    expect(searchTool.name).toBe("transcript_search");
  });

  test("handler 回傳固定外框與搜尋結果", async () => {
    await withTranscriptEnv("tool-search", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const handler = createTranscriptSearchHandler({
        env,
        dbPath: context.dbPath,
        autoIndex: false,
      });
      const result = handler({ query: "timeout" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.summary).toContain("找到");
      expect((result.data as { results: unknown[] }).results.length).toBeGreaterThan(0);
    });
  });
});

describe("transcript_read 工具", () => {
  test("輸入 schema 限制大小上限", () => {
    expect(transcriptReadSchema.safeParse({ sessionRef: "claude:x" }).success).toBe(true);
    expect(transcriptReadSchema.safeParse({ sessionRef: "" }).success).toBe(false);
    expect(
      transcriptReadSchema.safeParse({ sessionRef: "claude:x", maxTurns: 51 }).success,
    ).toBe(false);
    expect(
      transcriptReadSchema.safeParse({ sessionRef: "claude:x", maxChars: 10 }).success,
    ).toBe(false);
    expect(readTool.name).toBe("transcript_read");
  });

  test("handler 回傳指定對話的訊息", async () => {
    await withTranscriptEnv("tool-read", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_CLAUDE_PROJECTS_DIR: fixturePath("claude"),
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };
      buildTranscriptIndex({ env, dbPath: context.dbPath });

      const handler = createTranscriptReadHandler({ env, dbPath: context.dbPath });
      const result = handler({ sessionRef: "claude:claude-fixture-1", maxTurns: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { entries: { text: string }[] };
      expect(data.entries.length).toBeGreaterThan(0);
    });
  });
});
