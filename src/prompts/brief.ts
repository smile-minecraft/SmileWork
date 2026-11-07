import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { textPrompt, requireWorkDetail, withPromptContext } from "./shared.ts";

const argsSchema = z.object({
  workId: z.string().min(1).describe("要派工的工作識別碼"),
});

/** 把工作欄位產生的派工說明包成可直接交給執行代理的 prompt。 */
export function renderBriefPrompt(brief: string): string {
  return [
    "# 派工簡報",
    "",
    brief,
    "",
    "## 開始之前",
    "- 先確認目標、允許修改的範圍與驗收條件；資訊不足時先問，不要自行擴大範圍。",
    "- 完成後用 work_update 附上證據；需要可重現的驗證時呼叫 verify_run。",
    "- 只改允許範圍內的檔案，並保留其他人的修改。",
  ].join("\n");
}

export function registerBriefPrompt(server: McpServer): void {
  server.registerPrompt(
    "brief",
    {
      title: "派工簡報",
      description: "依工作欄位產生派工簡報，附上開始前的注意事項。",
      argsSchema,
    },
    ({ workId }) => {
      const text = withPromptContext((context) =>
        renderBriefPrompt(requireWorkDetail(context, workId).brief),
      );
      return textPrompt(text);
    },
  );
}
