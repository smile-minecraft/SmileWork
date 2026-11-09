import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import {
  getWorkDetail,
  parseToolInput,
  requireWorkProject,
} from "../../work/crud.ts";
import { ok } from "../../shared/result.ts";

const inputSchema = z.object({
  id: z.string().min(1).max(200),
  format: z.enum(["full", "brief"]).default("full"),
});

export const tool = defineTool({
  name: "work_get",
  title: "讀取工作",
  description:
    "讀取單一工作的欄位、驗收條件、依賴與證據。format=brief 時回傳由欄位產生的派工說明。",
  domain: "work",
  inputSchema,
  handler: (input, context) => {
    const parsed = parseToolInput(inputSchema, input);
    const project = requireWorkProject(context);
    const detail = getWorkDetail(context.db(), project.projectId, parsed.id);
    if (parsed.format === "brief") {
      return ok("已產生派工說明。", {
        id: detail.work.id,
        version: detail.work.version,
        brief: detail.brief,
      });
    }
    return ok("已讀取工作。", {
      work: detail.work,
      evidence: detail.evidence,
      handoff: detail.handoff,
      rulings: detail.rulings,
      relatedKnowledge: detail.relatedKnowledge,
    });
  },
});
