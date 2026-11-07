import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ReadResourceResult } from "@modelcontextprotocol/server";
import { createGitRepo } from "../helpers/git.ts";

export const repoRoot = join(import.meta.dir, "..", "..");

/** 一般執行代理要看到的 12 個工具。 */
export const WORKER_TOOL_NAMES = [
  "knowledge_read",
  "knowledge_search",
  "signal_note",
  "status",
  "verify_run",
  "work_complete",
  "work_create",
  "work_get",
  "work_list",
  "work_ready",
  "work_review",
  "work_update",
] as const;

/** 整理代理要看到的 15 個工具：能整理知識，但不能建立或修改工作。 */
export const CURATOR_TOOL_NAMES = [
  "knowledge_history",
  "knowledge_promote",
  "knowledge_read",
  "knowledge_revert",
  "knowledge_retire",
  "knowledge_search",
  "knowledge_write",
  "signal_list",
  "signal_mark",
  "signal_note",
  "status",
  "transcript_read",
  "transcript_search",
  "work_get",
  "work_list",
] as const;

export interface SurfaceServer {
  client: Client;
  close(): Promise<void>;
}

/** 以子程序啟動真正的 stdio 伺服器，讓 profile 與設定檔走正式入口。 */
export async function startSurfaceServer(env: Record<string, string>): Promise<SurfaceServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli/index.ts", "mcp"],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "smilework-surface-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

export interface SurfaceEnvOptions {
  root: string;
  home: string;
  profile?: string;
  project?: string;
}

export interface SurfaceEnv {
  env: Record<string, string>;
  repo: string;
}

/** 建立暫存 home 與 repo 的環境變數；未指定 profile 時移除宿主既有的值。 */
export async function createSurfaceEnv(options: SurfaceEnvOptions): Promise<SurfaceEnv> {
  const repo = options.project ?? (await createGitRepo(join(options.root, "repo")));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.SMILEWORK_HOME = options.home;
  env.SMILEWORK_PROJECT = repo;
  env.SMILEWORK_ACTOR = "surface-test";
  env.SMILEWORK_MODEL = "test-model";
  if (options.profile === undefined) {
    delete env.SMILEWORK_PROFILE;
  } else {
    env.SMILEWORK_PROFILE = options.profile;
  }
  return { env, repo };
}

export interface ToolPayload {
  ok: true;
  summary: string;
  data: Record<string, unknown>;
}

/** 呼叫工具並解析共用外框；失敗時把原始回應放進錯誤訊息。 */
export async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  if (block?.type !== "text") {
    throw new Error(`${name} 沒有回傳文字內容。`);
  }
  const parsed = JSON.parse(block.text) as Record<string, unknown>;
  if (parsed.ok !== true) {
    throw new Error(`${name} 失敗：${block.text}`);
  }
  return parsed as unknown as ToolPayload;
}

export function readResourceText(result: ReadResourceResult): string {
  const content = result.contents[0];
  if (content === undefined || !("text" in content)) {
    throw new Error("resource 沒有回傳文字內容。");
  }
  return content.text;
}

/**
 * 若工作區保留了 spike 的 gpt-tokenizer，就用 o200k_base 精測；
 * 乾淨環境沒有這個套件時回 null，由呼叫端改用固定比例估算。
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
