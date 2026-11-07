import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { createGitRepo } from "../../helpers/git.ts";
import { withTempHome } from "../../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

interface RunningServer {
  client: Client;
  close(): Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli/index.ts", "mcp"],
    cwd: repoRoot,
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "work-crud-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

let running: RunningServer | null = null;

afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
});

function parse(call: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const block = call.content[0];
  if (block?.type !== "text") throw new Error("工具沒有回傳文字內容。");
  return JSON.parse(block.text) as Record<string, any>;
}

describe("MCP client 工作流程", () => {
  test("建立、查詢、列出、可開始與更新一輪", async () => {
    await withTempHome("work-mcp", async (home, root) => {
      const project = await createGitRepo(join(root, "repo"));
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      env.SMILEWORK_HOME = home;
      env.SMILEWORK_PROJECT = project;
      env.SMILEWORK_ACTOR = "build";
      env.SMILEWORK_MODEL = "test-model";
      running = await startServer(env);
      const client = running.client;

      const created = parse(
        await client.callTool({
          name: "work_create",
          arguments: {
            title: "MCP 一輪",
            objective: "確認工具真的接上伺服器。",
            acceptance: ["建立成功", "更新成功"],
            dependsOn: [],
          },
        }),
      );
      expect(created.ok).toBe(true);
      const workId = created.data.work.id as string;
      expect(created.data.work.version).toBe(1);

      const fetched = parse(
        await client.callTool({ name: "work_get", arguments: { id: workId, format: "brief" } }),
      );
      expect(fetched.ok).toBe(true);
      expect(fetched.data.brief).toContain("確認工具真的接上伺服器。");

      const listed = parse(await client.callTool({ name: "work_list", arguments: {} }));
      expect(listed.ok).toBe(true);
      expect(listed.data.items.map((item: { id: string }) => item.id)).toContain(workId);

      const ready = parse(await client.callTool({ name: "work_ready", arguments: {} }));
      expect(ready.ok).toBe(true);
      expect(ready.data.items.map((item: { id: string }) => item.id)).toContain(workId);

      const updated = parse(
        await client.callTool({
          name: "work_update",
          arguments: {
            id: workId,
            expectedVersion: 1,
            status: "in_progress",
            evidence: [{ kind: "note", summary: "從 MCP 呼叫成功" }],
          },
        }),
      );
      expect(updated.ok).toBe(true);
      expect(updated.data.work.status).toBe("in_progress");
      expect(updated.data.work.version).toBe(2);
      expect(updated.data.evidence).toHaveLength(1);

      const stale = parse(
        await client.callTool({
          name: "work_update",
          arguments: { id: workId, expectedVersion: 1, title: "過期更新" },
        }),
      );
      expect(stale.ok).toBe(false);
      expect(stale.code).toBe("VERSION_CONFLICT");
      expect(stale.data.work.version).toBe(2);
    });
  }, 30_000);
});
