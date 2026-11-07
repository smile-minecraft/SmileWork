import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { textPrompt, requireWorkDetail, withPromptContext } from "./shared.ts";

const DEFAULT_FOCUS = "依驗收條件逐項核對證據，找出沒有被證據支持的說法。";

const argsSchema = z.object({
  workId: z.string().min(1).describe("要審查的工作識別碼"),
  focus: z.string().max(500).optional().describe("這次審查要特別看的地方"),
});

/** 獨立審查的提示：帶入工作內容，要求依證據而不是執行者的摘要判斷。 */
export function renderReviewPrompt(brief: string, focus: string | undefined): string {
  const reviewFocus = focus?.trim() ? focus.trim() : DEFAULT_FOCUS;
  return [
    "# 獨立審查",
    "",
    brief,
    "",
    "## 審查重點",
    reviewFocus,
    "",
    "## 回報方式",
    "- approve：所有驗收條件都有可重現的證據。",
    "- concerns：有小問題或需要補證據，先列具體位置與影響。",
    "- reject：有必須先修的問題；說明每一項的觸發條件與修正方向。",
    "用 work_review 回報 verdict 與 note。不要只採信執行者的摘要，必要時自己重跑驗證。",
  ].join("\n");
}

export function registerReviewPrompt(server: McpServer): void {
  server.registerPrompt(
    "review",
    {
      title: "獨立審查",
      description: "帶入工作內容與審查重點，產生獨立審查的指示。",
      argsSchema,
    },
    ({ workId, focus }) => {
      const text = withPromptContext((context) =>
        renderReviewPrompt(requireWorkDetail(context, workId).brief, focus),
      );
      return textPrompt(text);
    },
  );
}
