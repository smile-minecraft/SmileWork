import { describe, expect, test } from "bun:test";
import { tool as knowledgeRead } from "../../../src/tools/knowledge/read.ts";
import {
  appendVersion,
  callTool,
  dataOf,
  failureOf,
  seedKnowledge,
  usageStats,
  withDatabase,
  withKnowledgeFixture,
} from "./helpers.ts";

interface ReadVersionView {
  version: number;
  sha256: string;
  bytes: number;
  actor: string;
  actorModel: string | null;
  reason: string | null;
  sourceSignalIds: string[];
  createdAt: string;
}

interface ReadData {
  entry: {
    id: string;
    entryId: number;
    layer: string;
    projectId: string | null;
    kind: string;
    currentVersion: number;
    status: string;
  };
  version: ReadVersionView;
  content: string;
  contentBytes: number;
  usage: { readCount: number; lastReadAt: string | null };
}

const firstContent = "# 第一版\n\n內容含中文與 emoji 🚀\n";

describe("knowledge_read", () => {
  test("回傳全文與版本，並記且只記一筆使用事件", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-read",
        title: "讀取測試",
        content: firstContent,
        reason: "建立版本",
        sourceSignalIds: ["signal-read-1"],
      });

      const result = dataOf<ReadData>(await callTool(knowledgeRead, { knowledgeId: "k-read" }, fixture));
      expect(result.content).toBe(firstContent);
      expect(result.contentBytes).toBe(Buffer.byteLength(firstContent, "utf8"));
      expect(result.entry.id).toBe("k-read");
      expect(result.entry.entryId).toBe(entry.id);
      expect(result.entry.layer).toBe("project");
      expect(result.entry.projectId).toBe(fixture.project.projectId);
      expect(result.entry.currentVersion).toBe(1);
      expect(result.version.version).toBe(1);
      expect(result.version.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.version.actor).toBe("build");
      expect(result.version.actorModel).toBe("test-model");
      expect(result.version.reason).toBe("建立版本");
      expect(result.version.sourceSignalIds).toEqual(["signal-read-1"]);
      expect(result.usage.readCount).toBe(1);

      const usage = withDatabase(fixture, (db) =>
        db
          .query<{ action: string; actor: string; knowledge_id: string; version: number }, []>(
            "SELECT action, actor, knowledge_id, version FROM usage_events ORDER BY created_at, usage_id",
          )
          .all(),
      );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        action: "read",
        actor: "build",
        knowledge_id: "k-read",
        version: 1,
      });

      const second = dataOf<ReadData>(
        await callTool(knowledgeRead, { knowledgeId: "k-read" }, fixture),
      );
      expect(second.usage.readCount).toBe(2);
      expect(usageStats(fixture, entry.id).readCount).toBe(2);
    });
  });

  test("可以讀取指定版本，entry 的 currentVersion 不變", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-read-version",
        content: firstContent,
      });
      appendVersion(fixture, entry.id, "# 第二版\n\n更新後的內容\n", { reason: "第二版" });

      const oldVersion = dataOf<ReadData>(
        await callTool(knowledgeRead, { knowledgeId: "k-read-version", version: 1 }, fixture),
      );
      expect(oldVersion.content).toBe(firstContent);
      expect(oldVersion.version.version).toBe(1);
      expect(oldVersion.entry.currentVersion).toBe(2);
      expect(oldVersion.usage.readCount).toBe(1);

      const current = dataOf<ReadData>(
        await callTool(knowledgeRead, { knowledgeId: "k-read-version" }, fixture),
      );
      expect(current.content).toBe("# 第二版\n\n更新後的內容\n");
      expect(current.version.version).toBe(2);
      expect(current.usage.readCount).toBe(2);
    });
  });

  test("全文超過上限時拒絕，且不留下使用事件", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-read-large",
        content: "大".repeat(5000),
      });

      const failure = failureOf(
        await callTool(knowledgeRead, { knowledgeId: "k-read-large", maxChars: 100 }, fixture),
      );
      expect(failure.code).toBe("KNOWLEDGE_CONTENT_TOO_LARGE");
      expect(failure.message).toContain("5000");
      expect(usageStats(fixture, entry.id).readCount).toBe(0);
    });
  });

  test("全域知識用 layer=global 讀取", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, {
        knowledgeId: "k-read-global",
        layer: "global",
        title: "全域記憶",
        content: "全域內容",
      });

      const result = dataOf<ReadData>(
        await callTool(knowledgeRead, { knowledgeId: "k-read-global", layer: "global" }, fixture),
      );
      expect(result.entry.layer).toBe("global");
      expect(result.entry.projectId).toBeNull();
      expect(result.content).toBe("全域內容");
    });
  });

  test("不存在的知識與版本回清楚的錯誤", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, { knowledgeId: "k-read-missing-version", content: "內容" });

      expect(
        failureOf(await callTool(knowledgeRead, { knowledgeId: "k-unknown" }, fixture)).code,
      ).toBe("KNOWLEDGE_ENTRY_NOT_FOUND");
      expect(
        failureOf(
          await callTool(
            knowledgeRead,
            { knowledgeId: "k-read-missing-version", version: 9 },
            fixture,
          ),
        ).code,
      ).toBe("KNOWLEDGE_VERSION_NOT_FOUND");
    });
  });

  test("空白的 knowledgeId 回 VALIDATION_ERROR", async () => {
    await withKnowledgeFixture(async (fixture) => {
      expect(failureOf(await callTool(knowledgeRead, { knowledgeId: "" }, fixture)).code).toBe(
        "VALIDATION_ERROR",
      );
    });
  });
});
