import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { fail, failureFromError, ok } from "../../shared/result.ts";
import {
  runVerification,
  smileworkHomeForDatabase,
  writeVerificationEvidence,
} from "../../verify/index.ts";

const inputSchema = z.object({
  workId: z.string().min(1).optional().describe("要關聯證據的工作識別碼；與 workItemId 擇一。"),
  workItemId: z.string().min(1).optional().describe("workId 的別名，與 workId 擇一。"),
  runner: z.string().min(1).describe("bun、npm、pytest、cargo、gradle 或 swift。"),
  script: z.string().optional().describe("套件 runner 的 script；直接 runner 只能省略或 test。"),
  args: z.array(z.string()).optional().describe("runner 的額外參數，只接受白名單旗標。"),
  cwd: z.string().optional().describe("專案內的工作目錄；相對路徑以專案根目錄為基準。"),
  timeoutMs: z.number().int().positive().optional().describe("逾時毫秒數，上限 600000。"),
  projectPath: z.string().optional().describe("專案路徑；省略時依 SMILEWORK_PROJECT 或 cwd 解析。"),
});

export const tool = defineTool({
  name: "verify_run",
  title: "執行伺服器驗證",
  description: [
    "由伺服器執行白名單 runner 的驗證指令，並留下代理無法偽造的 serverIssued 證據。",
    "證據會關聯到 workId（或 workItemId）指定的工作。",
    "支援 bun、npm、pytest、cargo、gradle、swift；不開放任意 shell 指令。",
    "套件 runner（bun／npm）的 script 只允許 test／lint／typecheck／check／verify family（可帶 :suffix），或 format:check／format:verify。",
    "直接 runner（pytest／cargo／gradle／swift）的 script 可省略或填 test；測試目標與旗標放進 args。",
    "cwd 必須在專案內；參數指向專案外的既有路徑、非白名單旗標與未知 runner 都會被拒絕。",
    "捕捉到的輸出（有大小上限）寫到 SMILEWORK_HOME/evidence/，資料庫只存路徑、sha256、exitCode、duration 與摘要。",
  ].join("\n"),
  domain: "verify",
  inputSchema,
  handler: async (input, context) => {
    try {
      const workId = input.workId?.trim() || input.workItemId?.trim();
      if (!workId) {
        return fail(
          "INVALID_INPUT",
          "verify_run 需要 workId，才能把證據關聯到工作。",
          "先建立或查詢工作，取得 workId 後再呼叫 verify_run。",
          {},
        );
      }
      const project = context.resolveProject(input.projectPath);
      const db = context.db();
      const work = db
        .query<{ work_id: string }, [string, string]>(
          "SELECT work_id FROM work_items WHERE work_id = ? AND project_id = ?",
        )
        .get(workId, project.projectId);
      if (!work) {
        return fail(
          "NOT_FOUND",
          `找不到工作 ${workId}。`,
          "先用 work_list 或 work_get 確認工作識別碼，再呼叫 verify_run。",
          { workId, projectId: project.projectId },
        );
      }

      const result = await runVerification({
        projectRoot: project.worktreePath,
        runner: input.runner,
        script: input.script,
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        env: process.env,
      });
      const evidence = writeVerificationEvidence({
        db,
        home: smileworkHomeForDatabase(db),
        projectId: project.projectId,
        workId: work.work_id,
        actor: context.actor,
        result,
      });

      return ok(evidence.summary, {
        workId: work.work_id,
        projectId: project.projectId,
        policy: "restricted-verification-v1",
        ...result,
        serverIssued: true,
        evidence,
      });
    } catch (error) {
      return failureFromError(error);
    }
  },
});
