import { describe, expect, test } from "bun:test";
import { tool as knowledgeRead } from "../../../src/tools/knowledge/read.ts";
import {
  callTool,
  failureOf,
  seedKnowledge,
  withDatabase,
  withKnowledgeFixture,
  type KnowledgeFixture,
} from "../read/helpers.ts";

function corruptTags(fixture: KnowledgeFixture, knowledgeId: string, value: string): void {
  withDatabase(fixture, (db) => {
    const updated = db
      .query("UPDATE knowledge_entries SET tags = ? WHERE knowledge_id = ?")
      .run(value, knowledgeId);
    expect(updated.changes).toBe(1);
  });
}

describe("knowledge_read 讀到損壞的 tags", () => {
  test("tags 含非字串元素時回 INTERNAL_ERROR，訊息含 knowledge id 與 tags", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, { knowledgeId: "k-corrupt-tags", content: "內容\n" });
      corruptTags(fixture, "k-corrupt-tags", "[1,2]");

      const failure = failureOf(
        await callTool(knowledgeRead, { knowledgeId: "k-corrupt-tags" }, fixture),
      );
      expect(failure.code).toBe("INTERNAL_ERROR");
      expect(failure.message).toContain("k-corrupt-tags");
      expect(failure.message).toContain("tags");
      expect(failure.data).toMatchObject({ id: "k-corrupt-tags", field: "tags" });
    });
  });

  test("tags 不是合法 JSON 時回 INTERNAL_ERROR，不顯示成空陣列", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, { knowledgeId: "k-broken-tags", content: "內容\n" });
      corruptTags(fixture, "k-broken-tags", "not-json");

      const failure = failureOf(
        await callTool(knowledgeRead, { knowledgeId: "k-broken-tags" }, fixture),
      );
      expect(failure.code).toBe("INTERNAL_ERROR");
      expect(failure.message).toContain("k-broken-tags");
      expect(failure.message).toContain("tags");
    });
  });
});
