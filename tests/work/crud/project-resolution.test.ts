import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runTool } from "../../../src/mcp/result.ts";
import { toolByName } from "../../../src/mcp/registry.ts";
import { withTempDir, withTempHome } from "../../helpers/temp.ts";

function parse(result: Awaited<ReturnType<typeof runTool>>): Record<string, any> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("工具沒有回傳文字內容。");
  return JSON.parse(block.text) as Record<string, any>;
}

describe("專案無法解析", () => {
  test("沒有 SMILEWORK_PROJECT 且 cwd 不是 git repo 時回 PROJECT_UNRESOLVED", async () => {
    await withTempHome("work-project", async (home, root) => {
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

        const payload = parse(await runTool(tool, { title: "無專案" }, { env, cwd }));
        expect(payload).toMatchObject({ ok: false, code: "PROJECT_UNRESOLVED" });
        expect(typeof payload.nextAction).toBe("string");
      });
    });
  });

  test("專案路徑不存在時一樣回 PROJECT_UNRESOLVED", async () => {
    await withTempHome("work-project", async (home) => {
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
