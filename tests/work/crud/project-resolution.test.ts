import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTool } from "../../../src/mcp/result.ts";
import { toolByName } from "../../../src/mcp/registry.ts";
import { withTempDir, withTempHome } from "../../helpers/temp.ts";

function parse(result: Awaited<ReturnType<typeof runTool>>): Record<string, any> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("工具沒有回傳文字內容。");
  return JSON.parse(block.text) as Record<string, any>;
}

describe("非 git 專案的工作工具", () => {
  test("cwd 不是 git repo 時仍可建立工作，專案以路徑識別", async () => {
    await withTempHome("work-project", async (home) => {
      await withTempDir("work-cwd", async (cwd) => {
        const tool = toolByName("work_create");
        if (!tool) throw new Error("registry 缺少 work_create。");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SMILEWORK_HOME: home,
          SMILEWORK_ACTOR: "build",
          SMILEWORK_MODEL: "test-model",
        };
        delete env.SMILEWORK_PROJECT;

        const payload = parse(await runTool(tool, { title: "非 git 專案" }, { env, cwd }));
        expect(payload.ok).toBe(true);
        expect(payload.data.work.projectId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.data.work.title).toBe("非 git 專案");
      });
    });
  });

  test("先在 X 建工作，之後在 X/plugins 開啟會接回同一個專案", async () => {
    await withTempHome("work-ancestor-project", async (home) => {
      await withTempDir("work-ancestor-cwd", async (root) => {
        const projectRoot = join(root, "X");
        const nested = join(projectRoot, "plugins");
        mkdirSync(nested, { recursive: true });

        const createTool = toolByName("work_create");
        if (!createTool) throw new Error("registry 缺少 work_create。");
        const listTool = toolByName("work_list");
        if (!listTool) throw new Error("registry 缺少 work_list。");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SMILEWORK_HOME: home,
          SMILEWORK_ACTOR: "build",
        };
        delete env.SMILEWORK_PROJECT;

        const created = parse(
          await runTool(createTool, { title: "X 的工作" }, { env, cwd: projectRoot }),
        );
        expect(created.ok).toBe(true);
        const projectId = created.data.work.projectId;

        const listed = parse(await runTool(listTool, {}, { env, cwd: nested }));
        expect(listed.ok).toBe(true);
        expect(listed.data.items.map((item: { id: string }) => item.id)).toContain(
          created.data.work.id,
        );

        const createdFromNested = parse(
          await runTool(createTool, { title: "X/plugins 的工作" }, { env, cwd: nested }),
        );
        expect(createdFromNested.ok).toBe(true);
        expect(createdFromNested.data.work.projectId).toBe(projectId);
      });
    });
  });

  test("有 .ultrawork 的目錄會接到舊 projectId，而不是建立新專案", async () => {
    await withTempHome("work-legacy-project", async (home) => {
      await withTempDir("work-legacy-cwd", async (cwd) => {
        mkdirSync(join(cwd, ".ultrawork"), { recursive: true });
        writeFileSync(
          join(cwd, ".ultrawork", "tasks.json"),
          JSON.stringify({ projectId: "legacy-project", projectPath: cwd }),
          "utf8",
        );

        const tool = toolByName("work_create");
        if (!tool) throw new Error("registry 缺少 work_create。");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SMILEWORK_HOME: home,
          SMILEWORK_ACTOR: "build",
        };
        delete env.SMILEWORK_PROJECT;

        const payload = parse(await runTool(tool, { title: "舊專案工作" }, { env, cwd }));
        expect(payload.ok).toBe(true);
        expect(payload.data.work.projectId).toBe("legacy-project");
      });
    });
  });

  test("專案路徑不存在時回 PROJECT_UNRESOLVED", async () => {
    await withTempHome("work-project-missing", async (home) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SMILEWORK_HOME: home,
        SMILEWORK_PROJECT: join(home, "not-a-repo"),
        SMILEWORK_ACTOR: "build",
      };
      const tool = toolByName("work_list");
      if (!tool) throw new Error("registry 缺少 work_list。");
      const payload = parse(await runTool(tool, {}, { env, cwd: home }));
      expect(payload).toMatchObject({ ok: false, code: "PROJECT_UNRESOLVED" });
    });
  });
});
