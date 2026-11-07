import { z } from "zod";
import { RISK_LEVELS, WORK_KINDS, WORK_PRIORITIES } from "../../domain/index.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { createWork, parseToolInput, requireWorkProject } from "../../work/crud.ts";

const inputSchema = z.object({
  kind: z.enum(WORK_KINDS).default("task"),
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(4000).optional(),
  nonGoals: z.array(z.string().min(1).max(500)).max(50).default([]),
  contextRefs: z.array(z.string().min(1).max(500)).max(100).default([]),
  scopePaths: z.array(z.string().min(1).max(500)).max(100).default([]),
  acceptance: z.array(z.string().min(1).max(500)).max(50).default([]),
  dependsOn: z.array(z.string().min(1).max(200)).max(100).default([]),
  parentId: z.string().min(1).max(200).optional(),
  priority: z.enum(WORK_PRIORITIES).default("normal"),
  risk: z.enum(RISK_LEVELS).default("medium"),
  labels: z.array(z.string().min(1).max(64)).max(20).default([]),
  owner: z.string().min(1).max(100).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const tool = defineTool({
  name: "work_create",
  title: "建立工作",
  description:
    "建立一筆可被代理認領與追蹤的工作，支援驗收條件、依賴、標籤與冪等鍵。同一個 idempotencyKey 重送只會產生一筆。",
  domain: "work",
  inputSchema,
  handler: (input, context) => {
    const parsed = parseToolInput(inputSchema, input);
    const project = requireWorkProject(context);
    return createWork(context.db(), project, context.actor, {
      ...parsed,
      owner: parsed.owner ?? context.actor.name,
    });
  },
});
