import { z } from "zod";
import { WORK_KINDS, WORK_STATUSES } from "../../domain/index.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { listWorks, parseToolInput, requireWorkProject } from "../../work/crud.ts";
import { ok } from "../../shared/result.ts";

const inputSchema = z.object({
  status: z.array(z.enum(WORK_STATUSES)).min(1).max(6).optional(),
  owner: z.string().min(1).max(100).optional(),
  parentId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(64).optional(),
  kind: z.enum(WORK_KINDS).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
});

export const tool = defineTool({
  name: "work_list",
  title: "列出工作",
  description:
    "依狀態、負責人、上層工作、標籤與類型篩選工作，支援游標分頁。預設只回未結案項目。",
  domain: "work",
  inputSchema,
  handler: (input, context) => {
    const parsed = parseToolInput(inputSchema, input);
    const project = requireWorkProject(context);
    const result = listWorks(context.db(), project.projectId, parsed);
    return ok(`已列出 ${result.items.length} 筆工作。`, result);
  },
});
