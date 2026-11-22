import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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

/**
 * 多進位端對端測試用的驗證腳本：固定吐出超過 20KB 的雜訊，
 * 成敗由 src/passing.marker 決定，讓測試只改 scope 內的 src/ 就能切換結果。
 */
export const NOISY_VERIFY_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
awk 'BEGIN { for (i = 1; i <= 600; i++) printf "verify-noise-%04d %s\\n", i, "0123456789012345678901234567890123456789" }'
if [[ -f src/passing.marker ]]; then
  echo "verify: PASS"
  exit 0
fi
echo "FAIL src/workflow.ts > verification is red" >&2
echo "AssertionError: expected green verification" >&2
exit 1
`;

function commitFixture(cwd: string): void {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const add = Bun.spawnSync(["git", "add", "-A"], { cwd, env });
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = Bun.spawnSync(["git", "commit", "-m", "fixture"], { cwd, env });
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

export interface ScriptFixtureProject {
  repo: string;
  source: string;
  marker: string;
  outside: string;
}

/**
 * 建立一個所有 fixture 檔案都已提交的 git 專案，讓工作的 baseCommit 乾淨，
 * 測試期間的改動才會精確落在 scopePaths 與 diff 衛生的檢查範圍內。
 */
export async function createScriptFixtureProject(root: string): Promise<ScriptFixtureProject> {
  const repo = await createGitRepo(join(root, "project"));
  const scripts = join(repo, "scripts");
  const src = join(repo, "src");
  await mkdir(scripts, { recursive: true });
  await mkdir(src, { recursive: true });
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "multi-client-fixture", private: true }, null, 2)}\n`,
    "utf8",
  );
  const script = join(scripts, "verify.sh");
  await writeFile(script, NOISY_VERIFY_SCRIPT, "utf8");
  await chmod(script, 0o755);
  const source = join(src, "workflow.ts");
  await writeFile(source, 'export const workflow = "baseline";\n', "utf8");
  commitFixture(repo);
  return { repo, source, marker: join(src, "passing.marker"), outside: join(repo, "outside.txt") };
}

export interface RawFrame {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
}

export interface RawStdioSession {
  send(frame: unknown): Promise<void>;
  waitForResponse(id: number, timeoutMs?: number): Promise<RawFrame>;
  lines(): string[];
  stderrText(): Promise<string>;
  close(): Promise<number | null>;
}

function tryParseFrame(line: string): RawFrame | null {
  try {
    const value = JSON.parse(line) as RawFrame;
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** 直接對 child process 的 stdin/stdout 送收 JSON-RPC frame，不經過 MCP client 函式庫。 */
export async function startRawStdioSession(env: Record<string, string>): Promise<RawStdioSession> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", "mcp"], {
    cwd: repoRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";
  const pump = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) lines.push(buffer);
  })();
  const stderr = new Response(child.stderr).text();

  return {
    async send(frame: unknown): Promise<void> {
      child.stdin.write(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
    },
    async waitForResponse(id: number, timeoutMs = 10_000): Promise<RawFrame> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = lines
          .map(tryParseFrame)
          .find(
            (parsed) =>
              parsed !== null &&
              parsed.id === id &&
              (Object.hasOwn(parsed, "result") || Object.hasOwn(parsed, "error")),
          );
        if (match) return match;
        if (child.exitCode !== null) {
          throw new Error(`stdio server exited before response ${id}; stderr: ${await stderr}`);
        }
        await Bun.sleep(10);
      }
      throw new Error(`timed out waiting for response ${id}; stderr: ${await stderr}`);
    },
    lines(): string[] {
      return [...lines];
    },
    stderrText(): Promise<string> {
      return stderr;
    },
    async close(): Promise<number | null> {
      try {
        child.stdin.end();
      } catch {
        // stdin 已關閉時直接等進程結束。
      }
      await child.exited;
      await pump;
      return child.exitCode;
    },
  };
}
