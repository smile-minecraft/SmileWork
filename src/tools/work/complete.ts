import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { completeWork } from "../../work/lifecycle.ts";

const acceptanceResult = z.object({
  criterion: z.string().min(1).max(500),
  met: z.boolean(),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

export const tool = defineTool({
  name: "work_complete",
  title: "結案工作",
  description:
    "檢查驗收、證據、依賴與審查後結案；非高風險可從 in_progress 直接結案，高風險需非 owner approve 與伺服器證據。",
  domain: "work",
  inputSchema: z.object({
    id: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    acceptance: z.array(acceptanceResult),
    note: z.string().max(4000).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
  handler: (input, context) => {
    const project = context.resolveProject();
    return completeWork(context.db(), project.projectId, context.actor, {
      id: input.id,
      expectedVersion: input.expectedVersion,
      acceptance: input.acceptance,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    });
  },
});
