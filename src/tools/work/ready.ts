import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { parseToolInput, requireWorkProject } from "../../work/crud.ts";
import { listReadyWorks } from "../../work/ready.ts";
import { ok } from "../../shared/result.ts";

const inputSchema = z.object({
  parentId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const tool = defineTool({
  name: "work_ready",
  title: "列出可開始的工作",
  description: "列出狀態 open 且依賴都已完成的工作；依賴完成後會立刻出現在結果中。",
  domain: "work",
  inputSchema,
  handler: (input, context) => {
    const parsed = parseToolInput(inputSchema, input);
    const project = requireWorkProject(context);
    const items = listReadyWorks(context.db(), project.projectId, parsed);
    return ok(`目前有 ${items.length} 筆可開始的工作。`, { items });
  },
});
