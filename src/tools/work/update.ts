import { z } from "zod";
import { RISK_LEVELS, WORK_PRIORITIES, WORK_STATUSES } from "../../domain/index.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { parseToolInput, requireWorkProject, updateWork } from "../../work/crud.ts";

const evidenceSchema = z.object({
  kind: z.enum(["verify_run", "link", "output", "note"]),
  summary: z.string().trim().min(1).max(500),
  command: z.string().min(1).max(4000).optional(),
  output: z.string().max(20000).optional(),
  url: z.string().url().max(2000).optional(),
  path: z.string().min(1).max(1000).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const inputSchema = z.object({
  id: z.string().min(1).max(200),
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().max(4000).nullable().optional(),
  nonGoals: z.array(z.string().min(1).max(500)).max(50).optional(),
  contextRefs: z.array(z.string().min(1).max(500)).max(100).optional(),
  scopePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
  acceptance: z.array(z.string().min(1).max(500)).max(50).optional(),
  status: z.enum(WORK_STATUSES).optional(),
  owner: z.string().min(1).max(100).optional(),
  priority: z.enum(WORK_PRIORITIES).optional(),
  risk: z.enum(RISK_LEVELS).nullable().optional(),
  labels: z.array(z.string().min(1).max(64)).max(20).optional(),
  parentId: z.string().min(1).max(200).nullable().optional(),
  addDependsOn: z.array(z.string().min(1).max(200)).max(100).optional(),
  removeDependsOn: z.array(z.string().min(1).max(200)).max(100).optional(),
  evidence: z.array(evidenceSchema).max(50).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const tool = defineTool({
  name: "work_update",
  title: "更新工作",
  description:
    "以 expectedVersion 更新工作的欄位、狀態、依賴與人工證據。版本不符時回 VERSION_CONFLICT 與目前內容。",
  domain: "work",
  inputSchema,
  handler: (input, context) => {
    const parsed = parseToolInput(inputSchema, input);
    const project = requireWorkProject(context);
    return updateWork(context.db(), project, context.actor, parsed);
  },
});
