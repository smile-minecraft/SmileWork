import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResult } from "../../src/shared/result.ts";
import { createGitRepo } from "../helpers/git.ts";

export const repoRoot = join(import.meta.dir, "..", "..");

const SCRUBBED_ENV = [
  "SMILEWORK_HOME",
  "SMILEWORK_PROJECT",
  "SMILEWORK_ACTOR",
  "SMILEWORK_MODEL",
  "SMILEWORK_PROFILE",
  "SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
] as const;

export interface RunningServer {
  client: Client;
  close(): Promise<void>;
}

/** 從正式的 CLI 入口啟動 stdio 伺服器，端對端測試不繞過 profile 與設定載入。 */
export async function startE2eServer(env: Record<string, string>): Promise<RunningServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli/index.ts", "mcp"],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "smilework-e2e", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

/** 乾淨的宿主環境：沿用 PATH 等必要變數，但清掉所有 SMILEWORK_* 與 git 覆寫。 */
export function e2eEnvironment(
  home: string,
  project: string,
  options: { profile?: string; actor?: string; model?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of SCRUBBED_ENV) delete env[key];

  env.SMILEWORK_HOME = home;
  env.SMILEWORK_PROJECT = project;
  env.SMILEWORK_ACTOR = options.actor ?? "e2e-owner";
  env.SMILEWORK_MODEL = options.model ?? "e2e-model";
  if (options.profile !== undefined) env.SMILEWORK_PROFILE = options.profile;
  return env;
}

export interface E2eProject {
  repo: string;
  /** 執行真實 `bun run test` 的暫存專案；passing 控制測試內容。 */
  create(options?: { passing?: boolean }): Promise<string>;
}

/** 建立一個可被 verify_run 驗證的暫存 git 專案。 */
export async function createE2eProject(root: string): Promise<E2eProject> {
  const repo = await createGitRepo(join(root, "project"));
  return {
    repo,
    async create(options: { passing?: boolean } = {}): Promise<string> {
      const passing = options.passing ?? true;
      await mkdir(join(repo, "tests"), { recursive: true });
      await writeFile(
        join(repo, "package.json"),
        `${JSON.stringify({ name: "e2e-fixture", private: true, scripts: { test: "bun test" } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(repo, "tests", "fixture.test.ts"),
        [
          'import { expect, test } from "bun:test";',
          "",
          `test("fixture ${passing ? "passes" : "fails"}", () => {`,
          `  expect(${passing ? "1 + 1" : "1 + 1"}).toBe(${passing ? "2" : "3"});`,
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      return repo;
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`${name} 沒有回傳文字內容。`);
  return JSON.parse(block.text) as ToolResult;
}

/** 成功呼叫並回傳 data；失敗時把完整的工具外框放進錯誤訊息。 */
export async function callToolOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await callTool(client, name, args);
  if (!result.ok) {
    throw new Error(`${name} 失敗：${JSON.stringify(result)}`);
  }
  return result.data as Record<string, unknown>;
}

export function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * tools/list 的 token 量測：
 * - 有 .ultrawork 研究目錄裡的 gpt-tokenizer 時，用 o200k_base 精測；
 * - 沒有時退回 JSON 字元數除以 4 的固定比例估算。
 */
export function countO200kTokens(text: string): number | null {
  const spikeDir = join(repoRoot, ".ultrawork", "research", "spikes");
  if (!existsSync(join(spikeDir, "node_modules", "gpt-tokenizer"))) return null;
  try {
    const require = createRequire(join(spikeDir, "package.json"));
    const tokenizer = require("gpt-tokenizer") as { countTokens(input: string): number };
    return tokenizer.countTokens(text);
  } catch {
    return null;
  }
}
