import { describe, expect, test } from "bun:test";
import { globMatchesPath } from "../../../src/knowledge/relevant.ts";
import { expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("scopePaths 的 glob 比對", () => {
  test("沒有萬用字元時接受相同路徑、子路徑與上層資料夾", () => {
    expect(globMatchesPath("src/work", "src/work")).toBe(true);
    expect(globMatchesPath("src/work", "src/work/crud.ts")).toBe(true);
    expect(globMatchesPath("src/work", "src")).toBe(true);
    expect(globMatchesPath("src/work", "src/other")).toBe(false);
  });

  test("有萬用字元時接受 glob 命中的路徑，也接受工作的資料夾是靜態前綴", () => {
    expect(globMatchesPath("src/work/**", "src/work/crud.ts")).toBe(true);
    expect(globMatchesPath("src/**/crud.ts", "src/work/crud.ts")).toBe(true);
    expect(globMatchesPath("src/work/**", "src")).toBe(true);
    expect(globMatchesPath("src/work/**", "docs")).toBe(false);
  });
});

describe("brief 自動帶入相關知識", () => {
  test("只列出 scopePaths 對得上的 decision 與 pitfall，並附 ID 與摘要", async () => {
    await withWorkTools(async (context) => {
      expectOk(
        await context.call("knowledge_write", {
          kind: "memory",
          layer: "project",
          knowledgeId: "work-scope-decision",
          type: "decision",
          title: "工作工具的範圍",
          description: "工作工具要保留範圍與交接。",
          scopePaths: ["src/work/**"],
          content: "# 工作工具的範圍\n\n工作工具要保留範圍與交接。\n",
        }),
      );
      expectOk(
        await context.call("knowledge_write", {
          kind: "memory",
          layer: "project",
          knowledgeId: "docs-only-pitfall",
          type: "pitfall",
          title: "文件排版",
          description: "文件不要用過多層級。",
          scopePaths: ["docs/**"],
          content: "# 文件排版\n\n文件不要用過多層級。\n",
        }),
      );

      const work = expectOk(
        await context.call("work_create", {
          title: "相關知識",
          scopePaths: ["src/work/crud.ts"],
        }),
      ).data.work;

      const detail = expectOk(
        await context.call("work_get", { id: work.id, format: "full" }),
      ).data;
      expect(detail.relatedKnowledge).toHaveLength(1);
      expect(detail.relatedKnowledge[0]).toMatchObject({
        knowledgeId: "work-scope-decision",
        type: "decision",
        description: "工作工具要保留範圍與交接。",
        scopePaths: ["src/work/**"],
      });

      const brief = expectOk(
        await context.call("work_get", { id: work.id, format: "brief" }),
      ).data.brief as string;
      expect(brief).toContain("## 相關知識");
      expect(brief).toContain("work-scope-decision（decision）：工作工具要保留範圍與交接。");
      expect(brief).not.toContain("docs-only-pitfall");
    });
  });

  test("知識寫入拒絕絕對路徑與 ..，搜尋結果帶 scopePaths", async () => {
    await withWorkTools(async (context) => {
      const invalid = expectFail(
        await context.call("knowledge_write", {
          kind: "memory",
          layer: "project",
          knowledgeId: "bad-scope",
          type: "decision",
          content: "# 壞範圍\n\n內容。\n",
          scopePaths: ["../outside"],
        }),
      );
      expect(invalid.code).toBe("VALIDATION_ERROR");

      expectOk(
        await context.call("knowledge_write", {
          kind: "memory",
          layer: "project",
          knowledgeId: "searchable-scope",
          type: "pitfall",
          content: "# 可搜尋\n\n這段內容可以搜尋。\n",
          scopePaths: ["src/knowledge/**"],
        }),
      );
      const search = expectOk(
        await context.call("knowledge_search", { query: "可搜尋", scope: "project" }),
      ).data;
      const hit = search.results.find(
        (result: { knowledgeId: string }) => result.knowledgeId === "searchable-scope",
      );
      expect(hit).toMatchObject({ scopePaths: ["src/knowledge/**"] });
    });
  });

  test("工作沒有 scopePaths 時不帶入任何相關知識", async () => {
    await withWorkTools(async (context) => {
      expectOk(
        await context.call("knowledge_write", {
          kind: "memory",
          layer: "project",
          knowledgeId: "no-work-scope",
          type: "decision",
          content: "# 沒有工作範圍\n\n內容。\n",
          scopePaths: ["src/**"],
        }),
      );
      const work = expectOk(await context.call("work_create", { title: "沒有範圍" })).data.work;
      const detail = expectOk(
        await context.call("work_get", { id: work.id, format: "full" }),
      ).data;
      expect(detail.relatedKnowledge).toEqual([]);
      const brief = expectOk(
        await context.call("work_get", { id: work.id, format: "brief" }),
      ).data.brief as string;
      expect(brief).not.toContain("## 相關知識");
    });
  });
});
