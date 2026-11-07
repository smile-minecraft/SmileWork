import { describe, expect, test } from "bun:test";
import { tool as knowledgeSearch } from "../../../src/tools/knowledge/search.ts";
import {
  callTool,
  dataOf,
  failureOf,
  seedKnowledge,
  withKnowledgeFixture,
} from "./helpers.ts";

interface SearchResultItem {
  entryId: number;
  knowledgeId: string;
  layer: string;
  projectId: string | null;
  kind: string;
  type: string;
  title: string;
  status: string;
  pinned: boolean;
  currentVersion: number;
  updatedAt: string;
  matchedIn: string[];
  snippet: string;
}

interface SearchData {
  query: string;
  scope: string;
  projectId: string | null;
  total: number;
  hasMore: boolean;
  results: SearchResultItem[];
}

const longDeploymentContent = [
  "# 部署流程",
  "",
  ...Array.from({ length: 80 }, (_, index) => `前置說明第 ${index + 1} 行，與搜尋關鍵字無關。`),
  "Folia 測試服要先停止伺服器，再替換外掛 JAR。",
  ...Array.from({ length: 80 }, (_, index) => `後續說明第 ${index + 1} 行，也不含關鍵字。`),
].join("\n");

describe("knowledge_search", () => {
  test("搜尋 title、description 與 content，只回片段與識別碼", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, {
        knowledgeId: "k-deploy-flow",
        title: "部署流程",
        description: "部署到測試服的步驟",
        content: longDeploymentContent,
        sourceSignalIds: ["signal-deploy"],
      });

      const contentHit = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "Folia" }, fixture),
      );
      expect(contentHit.total).toBe(1);
      expect(contentHit.hasMore).toBe(false);
      const item = contentHit.results[0]!;
      expect(item.knowledgeId).toBe("k-deploy-flow");
      expect(item.entryId).toBeGreaterThan(0);
      expect(item.layer).toBe("project");
      expect(item.projectId).toBe(fixture.project.projectId);
      expect(item.kind).toBe("memory");
      expect(item.matchedIn).toContain("content");
      expect(item.snippet).toContain("Folia");
      expect(item.snippet.length).toBeLessThanOrEqual(200);
      expect(item.snippet.length).toBeLessThan(longDeploymentContent.length);
      expect("content" in item).toBe(false);
      expect(item).not.toHaveProperty("snapshotPath");

      const titleHit = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "部署流程" }, fixture),
      );
      expect(titleHit.results.map((result) => result.knowledgeId)).toEqual(["k-deploy-flow"]);
      expect(titleHit.results[0]!.matchedIn).toContain("title");

      const descriptionHit = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "測試服的步驟" }, fixture),
      );
      expect(descriptionHit.results[0]?.knowledgeId).toBe("k-deploy-flow");
      expect(descriptionHit.results[0]?.matchedIn).toContain("description");

      const miss = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "完全沒出現的字串" }, fixture),
      );
      expect(miss.results).toEqual([]);
      expect(miss.total).toBe(0);
    });
  });

  test("支援 kind、scope 與 limit，total 反映篩選後的數量", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, {
        knowledgeId: "k-project-memory",
        title: "共用關鍵字 專案記憶",
        content: "共用關鍵字出現在專案記憶。",
      });
      seedKnowledge(fixture, {
        knowledgeId: "k-project-skill",
        kind: "skill",
        type: "reference",
        title: "共用關鍵字 專案技能",
        content: "共用關鍵字出現在專案技能。",
      });
      seedKnowledge(fixture, {
        knowledgeId: "k-global-memory",
        layer: "global",
        title: "共用關鍵字 全域記憶",
        content: "共用關鍵字出現在全域記憶。",
      });

      const all = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "共用關鍵字", scope: "all" }, fixture),
      );
      expect(all.total).toBe(3);
      expect(new Set(all.results.map((result) => result.knowledgeId))).toEqual(
        new Set(["k-project-memory", "k-project-skill", "k-global-memory"]),
      );

      const projectOnly = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "共用關鍵字", scope: "project" }, fixture),
      );
      expect(projectOnly.total).toBe(2);
      expect(projectOnly.results.every((result) => result.layer === "project")).toBe(true);

      const globalOnly = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "共用關鍵字", scope: "global" }, fixture),
      );
      expect(globalOnly.total).toBe(1);
      expect(globalOnly.results[0]?.knowledgeId).toBe("k-global-memory");

      const skills = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "共用關鍵字", kind: "skill" }, fixture),
      );
      expect(skills.total).toBe(1);
      expect(skills.results[0]?.knowledgeId).toBe("k-project-skill");

      const limited = dataOf<SearchData>(
        await callTool(knowledgeSearch, { query: "共用關鍵字", limit: 2 }, fixture),
      );
      expect(limited.results).toHaveLength(2);
      expect(limited.total).toBe(3);
      expect(limited.hasMore).toBe(true);
    });
  });

  test("snippetChars 限制片段長度，預設排除退役項目", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const content = `${"開頭內容。".repeat(60)}裁切關鍵字${"結尾內容。".repeat(60)}`;
      seedKnowledge(fixture, {
        knowledgeId: "k-snippet",
        title: "片段測試",
        content,
      });
      seedKnowledge(fixture, {
        knowledgeId: "k-retired",
        title: "裁切關鍵字 已退役",
        content: "退役內容",
        status: "retired",
      });

      const small = dataOf<SearchData>(
        await callTool(
          knowledgeSearch,
          { query: "裁切關鍵字", snippetChars: 60 },
          fixture,
        ),
      );
      expect(small.results).toHaveLength(1);
      expect(small.results[0]!.knowledgeId).toBe("k-snippet");
      expect(small.results[0]!.snippet.length).toBeLessThanOrEqual(60);
      expect(small.results[0]!.snippet).toContain("裁切關鍵字");

      const withRetired = dataOf<SearchData>(
        await callTool(
          knowledgeSearch,
          { query: "裁切關鍵字", status: "all" },
          fixture,
        ),
      );
      expect(withRetired.total).toBe(2);
      expect(withRetired.results.map((result) => result.knowledgeId)).toContain("k-retired");
    });
  });

  test("不合法的分頁與片段長度回 VALIDATION_ERROR", async () => {
    await withKnowledgeFixture(async (fixture) => {
      expect(failureOf(await callTool(knowledgeSearch, { limit: 0 }, fixture)).code).toBe(
        "VALIDATION_ERROR",
      );
      expect(
        failureOf(await callTool(knowledgeSearch, { snippetChars: 1000 }, fixture)).code,
      ).toBe("VALIDATION_ERROR");
    });
  });
});
