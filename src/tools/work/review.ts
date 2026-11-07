import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { reviewWork } from "../../work/lifecycle.ts";

export const tool = defineTool({
  name: "work_review",
  title: "審查工作",
  description:
    "記錄獨立審查的結論、說明與審查者。owner 不能 approve 自己的工作；高風險工作需要非 owner 的核准。",
  domain: "work",
  inputSchema: z.object({
    id: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    verdict: z.enum(["approve", "concerns", "reject"]),
    note: z.string().max(4000).optional(),
    reviewer: z.string().min(1).max(200).optional(),
  }),
  handler: (input, context) => {
    const project = context.resolveProject();
    return reviewWork(context.db(), project.projectId, context.actor, {
      id: input.id,
      expectedVersion: input.expectedVersion,
      verdict: input.verdict,
      note: input.note,
      reviewer: input.reviewer,
    });
  },
});
