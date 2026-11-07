import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { ok } from "../../shared/result.ts";
import { inspectStatus, type DatabaseHealthStatus, type StatusReport } from "../../status/index.ts";

const DATABASE_LABELS: Record<DatabaseHealthStatus, string> = {
  ok: "正常",
  missing: "尚未建立",
  uninitialized: "尚未初始化",
  unavailable: "無法讀取",
};

function summarize(report: StatusReport): string {
  const database = DATABASE_LABELS[report.database.status];
  const project =
    report.project.status === "resolved" ? ` ${report.project.projectId}` : "未解析";
  const warningCount = report.warnings.length;
  return `smilework ${report.version.version}：資料庫${database}，專案${project}，profile ${report.profile.name}，${warningCount} 個警告。`;
}

export const tool = defineTool({
  name: "status",
  title: "查詢健康狀態",
  description:
    "唯讀回報伺服器版本、資料庫健康、專案解析、actor、profile、技能連結與對話索引狀態；缺少的資料庫或子系統只列警告，不會建立資料。",
  domain: "status",
  inputSchema: z.object({}),
  handler: (_input, context) => {
    const report = inspectStatus({
      actor: context.actor,
      actorHint: context.actorHint,
    });
    return ok(summarize(report), report);
  },
});
