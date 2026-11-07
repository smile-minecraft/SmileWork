import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { TOOLS_BY_DOMAIN } from "../../src/mcp/registry.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");

const EXPECTED_TOOLS = [
  "knowledge_history",
  "knowledge_promote",
  "knowledge_read",
  "knowledge_retire",
  "knowledge_revert",
  "knowledge_search",
  "knowledge_write",
  "signal_list",
  "signal_mark",
  "signal_note",
  "status",
  "transcript_read",
  "transcript_search",
  "verify_run",
  "work_complete",
  "work_create",
  "work_get",
  "work_list",
  "work_ready",
  "work_review",
  "work_update",
] as const;

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
  const client = new Client({ name: "smilework-core-test", version: "0.0.0" });
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

describe("MCP 伺服器骨架", () => {
  test("registry 依六個領域掛載 21 個工具", () => {
    expect(Object.keys(TOOLS_BY_DOMAIN).sort()).toEqual([
      "knowledge",
      "signal",
      "status",
      "transcript",
      "verify",
      "work",
    ]);
    expect(TOOLS_BY_DOMAIN.work).toHaveLength(7);
    expect(TOOLS_BY_DOMAIN.verify).toHaveLength(1);
    expect(TOOLS_BY_DOMAIN.status).toHaveLength(1);
    expect(TOOLS_BY_DOMAIN.signal).toHaveLength(3);
    expect(TOOLS_BY_DOMAIN.knowledge).toHaveLength(7);
    expect(TOOLS_BY_DOMAIN.transcript).toHaveLength(2);
    expect(Object.values(TOOLS_BY_DOMAIN).flat()).toHaveLength(21);
  });

  test("tools/list 在 full profile 回 21 個工具，status 回應符合固定外框", async () => {
    await withTempDir("mcp-server", async (root) => {
      const home = join(root, "home", ".smilework");
      const project = await createGitRepo(join(root, "repo"));
      running = await startServer({
        ...process.env,
        SMILEWORK_HOME: home,
        SMILEWORK_PROJECT: project,
        SMILEWORK_ACTOR: "test-agent",
        SMILEWORK_MODEL: "test-model",
        SMILEWORK_PROFILE: "full",
      });

      const listed = await running.client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

      // 工具會陸續從佔位實作換成真的實作，這裡只驗證成功與失敗共用的外框。
      const called = await running.client.callTool({ name: "status", arguments: {} });
      const block = called.content[0];
      expect(block?.type).toBe("text");
      const text = block?.type === "text" ? block.text : "";
      const payload = JSON.parse(text) as Record<string, unknown>;

      expect(payload.ok).toBe(!called.isError);
      if (payload.ok === true) {
        expect(typeof payload.summary).toBe("string");
        expect(typeof payload.data).toBe("object");
        expect(payload.data).not.toBeNull();
      } else if (payload.ok === false) {
        expect(typeof payload.code).toBe("string");
        expect(typeof payload.message).toBe("string");
        expect(typeof payload.nextAction).toBe("string");
      } else {
        throw new Error(`status 回應缺少 ok 欄位：${text}`);
      }
    });
  }, 30_000);
});
