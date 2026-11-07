import { z } from "zod";
import { SIGNAL_KINDS, SIGNAL_STATUSES } from "../../domain/signal.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { ok } from "../../shared/result.ts";
import { requireSignalProject } from "../../signal/project.ts";
import { listSignals } from "../../signal/store.ts";
import { parseSignalInput } from "../../signal/validation.ts";

const inputSchema = z.object({
  status: z.enum(SIGNAL_STATUSES).optional(),
  kind: z.enum(SIGNAL_KINDS).optional(),
  since: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), "since 必須是合法的日期時間。")
    .optional(),
  scope: z.enum(["project", "global", "all"]).default("project"),
  projectPath: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const tool = defineTool({
  name: "signal_list",
  title: "列出訊號",
  description:
    "依狀態、時間、範圍與種類列出訊號，支援 limit/offset 分頁。scope=project 只看目前專案，global 只看全域，all 兩者都看。",
  domain: "signal",
  validation: "handler",
  inputSchema,
  handler(input, context) {
    const parsed = parseSignalInput(inputSchema, input);
    const projectId =
      parsed.scope === "global"
        ? null
        : requireSignalProject(context, parsed.projectPath).projectId;

    const result = listSignals(context.db(), {
      projectId,
      scope: parsed.scope,
      status: parsed.status,
      kind: parsed.kind,
      since: parsed.since === undefined ? undefined : new Date(parsed.since).toISOString(),
      limit: parsed.limit,
      offset: parsed.offset,
    });

    return ok(`列出 ${result.signals.length} 筆訊號（共 ${result.total} 筆）。`, result);
  },
});
