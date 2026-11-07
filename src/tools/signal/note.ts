import { z } from "zod";
import { SIGNAL_KINDS, SIGNAL_SCOPES } from "../../domain/signal.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { ok } from "../../shared/result.ts";
import { createSignal } from "../../signal/store.ts";
import { requireSignalProject } from "../../signal/project.ts";
import { parseSignalInput } from "../../signal/validation.ts";

const inputSchema = z.object({
  kind: z.enum(SIGNAL_KINDS),
  content: z.string().min(1).max(1000),
  scope: z.enum(SIGNAL_SCOPES).default("project"),
  workItemId: z.string().min(1).max(256).optional(),
  refs: z.array(z.string().min(1)).max(100).default([]),
  idempotencyKey: z.string().min(1).max(256).optional(),
  projectPath: z.string().min(1).optional(),
});

export const tool = defineTool({
  name: "signal_note",
  title: "記錄訊號",
  description:
    "記下被糾正、失敗、修好、審查退回、教訓或其他訊號。content 最多 1000 字元；可用 workItemId 與 refs 連結來源，並以 idempotencyKey 安全重送。",
  domain: "signal",
  validation: "handler",
  inputSchema,
  handler(input, context) {
    const parsed = parseSignalInput(inputSchema, input);
    const project =
      parsed.scope === "project" ? requireSignalProject(context, parsed.projectPath) : null;

    const { signal, idempotentReplay } = createSignal(context.db(), {
      projectId: project?.projectId ?? null,
      scope: parsed.scope,
      kind: parsed.kind,
      content: parsed.content,
      workId: parsed.workItemId ?? null,
      refs: parsed.refs,
      idempotencyKey: parsed.idempotencyKey ?? null,
      actor: context.actor,
    });

    return ok(
      idempotentReplay
        ? `訊號 ${signal.signalId} 已存在，回傳原本的記錄。`
        : `已記錄訊號 ${signal.signalId}。`,
      { signal, idempotentReplay },
    );
  },
});
