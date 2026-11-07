import type { Database } from "bun:sqlite";
import { openDatabase } from "../../../src/db/index.ts";
import type { ProjectContext } from "../../../src/domain/project.ts";
import { runTool } from "../../../src/mcp/result.ts";
import type { ToolDefinition } from "../../../src/mcp/types.ts";
import { resolveProject } from "../../../src/project/resolve.ts";
import type { ToolResult, ToolSuccess } from "../../../src/shared/result.ts";
import { createGitRepo } from "../../helpers/git.ts";
import { withTempHome } from "../../helpers/temp.ts";

export interface KnowledgeWriteFixture {
  home: string;
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  project: ProjectContext;
}

/** 每個測試使用自己的暫存 SMILEWORK_HOME 與 HOME，不碰真實使用者資料。 */
export async function withKnowledgeWriteFixture(
  run: (fixture: KnowledgeWriteFixture) => Promise<void>,
): Promise<void> {
  await withTempHome("knowledge-write", async (home, root) => {
    const repo = await createGitRepo(`${root}/repo`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: `${root}/home`,
      SMILEWORK_HOME: home,
      SMILEWORK_PROJECT: repo,
      SMILEWORK_ACTOR: "build",
      SMILEWORK_MODEL: "test-model",
    };
    const project = resolveProject({ explicitPath: repo, env });
    await run({ home, root, repo, env, project });
  });
}

export function withDatabase<T>(fixture: KnowledgeWriteFixture, run: (db: Database) => T): T {
  const db = openDatabase({ home: fixture.home });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 從 MCP 外框取出工具回傳的 JSON，和宿主看到的內容一致。 */
export async function callTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  fixture: KnowledgeWriteFixture,
): Promise<ToolResult> {
  const result = await runTool(tool, input, { env: fixture.env, cwd: fixture.repo });
  const block = result.content[0];
  const text = block?.type === "text" ? block.text : "";
  return JSON.parse(text) as ToolResult;
}

export function dataOf<T>(result: ToolResult): T {
  if (!result.ok) throw new Error(`工具回傳失敗：${result.code} ${result.message}`);
  return (result as ToolSuccess<T>).data;
}

export function failureOf(result: ToolResult): { code: string; message: string; data: Record<string, unknown> } {
  if (result.ok) throw new Error("預期工具回傳失敗，但得到成功結果。");
  return { code: result.code, message: result.message, data: result.data };
}
