import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDatabase } from "../../../src/db/index.ts";
import { toolByName } from "../../../src/mcp/registry.ts";
import { runTool } from "../../../src/mcp/result.ts";
import type { ToolFailure, ToolResult, ToolSuccess } from "../../../src/shared/result.ts";
import { createGitRepo } from "../../helpers/git.ts";
import { withTempHome } from "../../helpers/temp.ts";

export interface WorkTestContext {
  home: string;
  projectPath: string;
  env: NodeJS.ProcessEnv;
  call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  openDb(): Database;
}

/** 每個測試各自一個暫存 HOME 與 git repo，工具呼叫共用同一個資料庫。 */
export async function withWorkTools<T>(run: (context: WorkTestContext) => Promise<T>): Promise<T> {
  return withTempHome("work-crud", async (home, root) => {
    const projectPath = await createGitRepo(join(root, "repo"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SMILEWORK_HOME: home,
      SMILEWORK_PROJECT: projectPath,
      SMILEWORK_ACTOR: "build",
      SMILEWORK_MODEL: "test-model",
    };

    const context: WorkTestContext = {
      home,
      projectPath,
      env,
      async call(name, input) {
        const tool = toolByName(name);
        if (!tool) throw new Error(`registry 找不到工具：${name}`);
        const result = await runTool(tool, input, { env });
        const block = result.content[0];
        if (block?.type !== "text") throw new Error(`工具 ${name} 沒有回傳文字內容。`);
        return JSON.parse(block.text) as ToolResult;
      },
      openDb() {
        return openDatabase({ home });
      },
    };

    return run(context);
  });
}

export function expectOk(result: ToolResult): ToolSuccess<any> {
  if (!result.ok) {
    throw new Error(`預期成功，實際失敗：${result.code} ${result.message}`);
  }
  return result;
}

export function expectFail(result: ToolResult): ToolFailure {
  if (result.ok) {
    throw new Error(`預期失敗，實際成功：${result.summary}`);
  }
  return result;
}

/** 直接改資料庫把依賴標成 done，結案工具由另一個任務負責。 */
export function markWorkDone(home: string, workId: string): void {
  const db = openDatabase({ home });
  try {
    const now = new Date().toISOString();
    const result = db
      .query(
        `UPDATE work_items
         SET status = 'done', resolution = 'completed', version = version + 1, updated_at = ?
         WHERE work_id = ?`,
      )
      .run(now, workId);
    if (result.changes !== 1) throw new Error(`找不到要標成完成的工作：${workId}`);
  } finally {
    db.close();
  }
}

export function countRows(home: string, table: "work_items" | "evidence"): number {
  const db = openDatabase({ home });
  try {
    const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}
