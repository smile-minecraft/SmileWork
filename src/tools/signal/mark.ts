import { z } from "zod";
import { SIGNAL_STATUSES } from "../../domain/signal.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { ok } from "../../shared/result.ts";
import { markSignals } from "../../signal/store.ts";
import { parseSignalInput } from "../../signal/validation.ts";

const inputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  status: z.enum(SIGNAL_STATUSES),
  reason: z.string().min(1).max(1000).optional(),
  resultRefs: z.array(z.string().min(1)).max(100).optional(),
});

export const tool = defineTool({
  name: "signal_mark",
  title: "標記訊號",
  description:
    "把訊號標記為 new、consumed 或 dismissed，可附處理理由與結果參照。只更新狀態與處理資訊，不改原始內容與建立時間；任何一個 id 不存在就整批不更新。",
  domain: "signal",
  validation: "handler",
  inputSchema,
  handler(input, context) {
    const parsed = parseSignalInput(inputSchema, input, { statusField: "status" });

    const signals = markSignals(context.db(), {
      ids: parsed.ids,
      status: parsed.status,
      reason: parsed.reason,
      resultRefs: parsed.resultRefs,
      actor: context.actor,
    });

    return ok(`已把 ${signals.length} 筆訊號標記為 ${parsed.status}。`, { signals });
  },
});
