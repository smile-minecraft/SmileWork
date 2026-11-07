import { describe, expect, test } from "bun:test";
import { callToolJson, createSurfaceEnv, readResourceText, startSurfaceServer } from "./helpers.ts";
import { withTempHome } from "../helpers/temp.ts";

interface CreatedWork {
  id: string;
  projectId: string;
  title: string;
}

describe("MCP resources", () => {
  test("工作看板、單一工作與知識索引都可讀取", async () => {
    await withTempHome("mcp-surface-resources", async (home, root) => {
      const prepared = await createSurfaceEnv({ root, home, profile: "full" });
      const server = await startSurfaceServer(prepared.env);
      try {
        const templates = await server.client.listResourceTemplates();
        expect(templates.resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
          "smilework://board/{projectId}",
          "smilework://knowledge/index/{scope}",
          "smilework://work/{id}",
        ]);

        const created = await callToolJson(server.client, "work_create", {
          title: "資源測試工作",
          objective: "確認 board 與 work resource 可以讀到工作內容。",
          acceptance: ["board 列出這筆工作", "work resource 含驗收條件"],
          risk: "low",
        });
        const work = created.data.work as CreatedWork;

        const boardResult = await server.client.readResource({
          uri: `smilework://board/${work.projectId}`,
        });
        const board = readResourceText(boardResult);
        expect(boardResult.contents[0]?.mimeType).toBe("text/markdown");
        expect(board).toContain(work.projectId);
        expect(board).toContain(work.id);
        expect(board).toContain("資源測試工作");
        expect(board).toContain("## open");

        const workResult = await server.client.readResource({
          uri: `smilework://work/${work.id}`,
        });
        const workText = readResourceText(workResult);
        expect(workText).toContain("資源測試工作");
        expect(workText).toContain("確認 board 與 work resource 可以讀到工作內容。");
        expect(workText).toContain("board 列出這筆工作");
        expect(workText).toContain("## 證據");

        await callToolJson(server.client, "knowledge_write", {
          kind: "memory",
          layer: "project",
          knowledgeId: "surface-project-index",
          title: "專案索引測試",
          description: "確認專案知識索引。",
          type: "reference",
          content: "# 專案索引測試\n\n這是專案層的測試內容。",
        });
        await callToolJson(server.client, "knowledge_write", {
          kind: "memory",
          layer: "global",
          knowledgeId: "surface-global-index",
          title: "全域索引測試",
          description: "確認全域知識索引。",
          type: "reference",
          content: "# 全域索引測試\n\n這是全域層的測試內容。",
        });

        const projectIndex = readResourceText(
          await server.client.readResource({ uri: "smilework://knowledge/index/project" }),
        );
        expect(projectIndex).toContain("surface-project-index");
        expect(projectIndex).toContain("專案索引測試");
        expect(projectIndex).not.toContain("surface-global-index");

        const globalIndex = readResourceText(
          await server.client.readResource({ uri: "smilework://knowledge/index/global" }),
        );
        expect(globalIndex).toContain("surface-global-index");
        expect(globalIndex).not.toContain("surface-project-index");

        const allIndex = readResourceText(
          await server.client.readResource({ uri: "smilework://knowledge/index/all" }),
        );
        expect(allIndex).toContain("surface-project-index");
        expect(allIndex).toContain("surface-global-index");
      } finally {
        await server.close();
      }
    });
  }, 30_000);

  test("fresh DB 與零 work 時回空看板，建立工作後看得到", async () => {
    await withTempHome("mcp-surface-board-empty", async (home, root) => {
      const prepared = await createSurfaceEnv({ root, home, profile: "full" });
      const server = await startSurfaceServer(prepared.env);
      try {
        const status = await callToolJson(server.client, "status", {});
        const project = status.data.project as {
          status: string;
          projectId: string | null;
        };
        expect(project.status).toBe("resolved");
        const projectId = project.projectId;
        expect(projectId).not.toBeNull();
        if (projectId === null) return;

        const emptyBoard = readResourceText(
          await server.client.readResource({ uri: `smilework://board/${projectId}` }),
        );
        expect(emptyBoard).toContain(projectId);
        expect(emptyBoard).toContain("共 0 筆工作");
        expect(emptyBoard).toContain("目前沒有工作");

        const created = await callToolJson(server.client, "work_create", {
          title: "空看板之後的工作",
          acceptance: ["board 會出現這筆工作"],
          risk: "low",
        });
        const work = created.data.work as CreatedWork;

        const board = readResourceText(
          await server.client.readResource({ uri: `smilework://board/${projectId}` }),
        );
        expect(board).toContain(work.id);
        expect(board).toContain("空看板之後的工作");
        expect(board).toContain("## open（1）");
      } finally {
        await server.close();
      }
    });
  }, 30_000);

  test("不存在的 resource 目標會回錯誤", async () => {
    await withTempHome("mcp-surface-resources-missing", async (home, root) => {
      const prepared = await createSurfaceEnv({ root, home, profile: "full" });
      const server = await startSurfaceServer(prepared.env);
      try {
        let failed = false;
        try {
          await server.client.readResource({ uri: "smilework://work/work-does-not-exist" });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      } finally {
        await server.close();
      }
    });
  }, 30_000);
});
