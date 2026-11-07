import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { withTempDir } from "../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");

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
  const client = new Client({ name: "smilework-validation-test", version: "0.0.0" });
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

function parseToolText(response: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = response.content[0];
  expect(block?.type).toBe("text");
  const text = block?.type === "text" ? block.text : "";
  expect(text).not.toContain("Input validation error");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP 輸入驗證外框", () => {
  test("tools/list 保留真實 input schema", async () => {
    await withTempDir("mcp-validation-schema", async (root) => {
      running = await startServer({
        ...process.env,
        SMILEWORK_HOME: join(root, "home", ".smilework"),
      });

      const listed = await running.client.listTools();
      const workCreate = listed.tools.find((tool) => tool.name === "work_create");
      expect(workCreate).toBeDefined();
      expect(workCreate?.inputSchema.type).toBe("object");
      expect(workCreate?.inputSchema.required).toContain("title");
      expect(workCreate?.inputSchema.properties).toHaveProperty("title");
      expect(workCreate?.inputSchema.properties).toHaveProperty("kind");
    });
  }, 30_000);

  test("缺必填、空 title、非法 kind 與缺 runner 都回固定外框", async () => {
    await withTempDir("mcp-validation-errors", async (root) => {
      running = await startServer({
        ...process.env,
        SMILEWORK_HOME: join(root, "home", ".smilework"),
      });

      const cases = [
        { name: "work_create", arguments: {} },
        { name: "work_create", arguments: { title: "" } },
        { name: "work_create", arguments: { title: "ok", kind: "bogus" } },
        { name: "verify_run", arguments: {} },
      ] as const;

      for (const entry of cases) {
        const response = await running.client.callTool({ name: entry.name, arguments: entry.arguments });
        expect(response.isError).toBe(true);
        const payload = parseToolText(response);
        expect(payload.ok).toBe(false);
        expect(typeof payload.code).toBe("string");
        expect(payload.code).toBe("VALIDATION_ERROR");
        expect(typeof payload.message).toBe("string");
        expect(typeof payload.nextAction).toBe("string");
        expect(Array.isArray((payload.data as Record<string, unknown>).issues)).toBe(true);
      }
    });
  }, 30_000);
});
