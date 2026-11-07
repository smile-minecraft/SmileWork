import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { tool as knowledgePromote } from "../../../src/tools/knowledge/promote.ts";
import { tool as knowledgeRetire } from "../../../src/tools/knowledge/retire.ts";
import { tool as knowledgeWrite } from "../../../src/tools/knowledge/write.ts";
import { callTool, failureOf, withKnowledgeWriteFixture } from "./helpers.ts";

describe("知識寫入工具的 schema", () => {
  test("三個工具都有 zod schema 與固定名稱", () => {
    for (const tool of [knowledgeWrite, knowledgeRetire, knowledgePromote]) {
      expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
      expect(tool.domain).toBe("knowledge");
      expect(typeof tool.handler).toBe("function");
    }
    expect(knowledgeWrite.name).toBe("knowledge_write");
    expect(knowledgeRetire.name).toBe("knowledge_retire");
    expect(knowledgePromote.name).toBe("knowledge_promote");
  });

  test("knowledge_write 接受技能附檔、版本、來源訊號與冪等鍵", () => {
    const parsed = knowledgeWrite.inputSchema.safeParse({
      kind: "skill",
      layer: "project",
      knowledgeId: "schema-skill",
      title: "Schema",
      description: "Schema 測試",
      content: "---\nname: schema-skill\ndescription: Schema 測試\n---\n\n# Schema\n",
      files: [{ path: "references/a.md", content: "a" }],
      expectedVersion: 1,
      sourceSignalIds: ["signal-1"],
      reason: "測試",
      idempotencyKey: "schema-1",
    });
    expect(parsed.success).toBe(true);
  });

  test("缺少必填欄位時回 VALIDATION_ERROR，不會建立任何檔案", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const missing = failureOf(
        await callTool(knowledgeWrite, { kind: "memory", layer: "global" }, fixture),
      );
      expect(missing.code).toBe("VALIDATION_ERROR");
      expect(missing.data.issues).toBeDefined();
    });
  });
});
