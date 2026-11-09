import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { searchTranscripts, type TranscriptServiceOptions } from "../../transcripts/search.ts";
import type { ToolResult } from "../../shared/result.ts";

export const transcriptSearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("要搜尋的關鍵字；中文 2 個字元會改用子字串比對。"),
  source: z.enum(["claude", "codex", "opencode", "pi"]).optional().describe("只搜尋指定來源。"),
  project: z.string().min(1).optional().describe("只搜尋指定專案根目錄的對話。"),
  since: z
    .string()
    .min(1)
    .optional()
    .describe("只回傳這個時間之後的訊息，ISO 8601 或 YYYY-MM-DD。"),
  limit: z.number().int().min(1).max(50).optional().describe("回傳筆數上限，預設 20。"),
});

export type TranscriptSearchToolInput = z.infer<typeof transcriptSearchSchema>;

export function createTranscriptSearchHandler(
  options: TranscriptServiceOptions = {},
): (input: TranscriptSearchToolInput) => ToolResult {
  return (input) => searchTranscripts(input, options);
}

export const tool = defineTool({
  name: "transcript_search",
  title: "搜尋對話紀錄",
  description:
    "搜尋 Claude Code、Codex、OpenCode 與 Pi 的對話紀錄。第一次呼叫會在背景建立索引，命中內容已遮蔽疑似機密。",
  domain: "transcript",
  inputSchema: transcriptSearchSchema,
  handler: createTranscriptSearchHandler(),
});
