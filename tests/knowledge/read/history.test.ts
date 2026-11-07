import { describe, expect, test } from "bun:test";
import { tool as knowledgeHistory } from "../../../src/tools/knowledge/history.ts";
import {
  appendVersion,
  callTool,
  dataOf,
  failureOf,
  seedKnowledge,
  withDatabase,
  withKnowledgeFixture,
} from "./helpers.ts";

interface HistoryVersion {
  version: number;
  sha256: string;
  bytes: number;
  actor: string;
  actorModel: string | null;
  reason: string | null;
  sourceSignalIds: string[];
  createdAt: string;
  previousVersion: number | null;
  diff: string;
}

interface HistoryData {
  entry: {
    id: string;
    entryId: number;
    layer: string;
    currentVersion: number;
  };
  total: number;
  versions: HistoryVersion[];
}

describe("knowledge_history", () => {
  test("列出每個版本、diff、作者、理由與來源訊號", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-history",
        content: "第一行\n舊內容\n第三行\n",
        reason: "初始版本",
        sourceSignalIds: ["signal-1"],
      });
      appendVersion(fixture, entry.id, "第一行\n新內容\n第三行\n", {
        reason: "補充內容",
        sourceSignalIds: ["signal-2"],
      });
      appendVersion(fixture, entry.id, "完全改寫\n", {
        reason: "改寫整份",
        sourceSignalIds: ["signal-3", "signal-4"],
      });

      const result = dataOf<HistoryData>(
        await callTool(knowledgeHistory, { knowledgeId: "k-history" }, fixture),
      );
      expect(result.entry.id).toBe("k-history");
      expect(result.entry.currentVersion).toBe(3);
      expect(result.total).toBe(3);
      expect(result.versions.map((version) => version.version)).toEqual([1, 2, 3]);

      const [first, second, third] = result.versions as [HistoryVersion, HistoryVersion, HistoryVersion];
      expect(first.previousVersion).toBeNull();
      expect(first.diff).toContain("+第一行");
      expect(first.actor).toBe("build");
      expect(first.actorModel).toBe("test-model");
      expect(first.reason).toBe("初始版本");
      expect(first.sourceSignalIds).toEqual(["signal-1"]);

      expect(second.previousVersion).toBe(1);
      expect(second.diff).toContain("-舊內容");
      expect(second.diff).toContain("+新內容");
      expect(second.reason).toBe("補充內容");
      expect(second.sourceSignalIds).toEqual(["signal-2"]);

      expect(third.previousVersion).toBe(2);
      expect(third.diff).toContain("-第一行");
      expect(third.diff).toContain("+完全改寫");
      expect(third.sourceSignalIds).toEqual(["signal-3", "signal-4"]);

      for (const version of result.versions) {
        expect(version.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(version).not.toHaveProperty("content");
        expect(version).not.toHaveProperty("snapshotPath");
      }

      const usageCount = withDatabase(
        fixture,
        (db) =>
          db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM usage_events").get()?.count,
      );
      expect(usageCount).toBe(0);
    });
  });

  test("不存在的知識項目回清楚的錯誤", async () => {
    await withKnowledgeFixture(async (fixture) => {
      expect(
        failureOf(await callTool(knowledgeHistory, { knowledgeId: "k-history-unknown" }, fixture)).code,
      ).toBe("KNOWLEDGE_ENTRY_NOT_FOUND");
    });
  });
});
