import { z } from "zod";
import { defineTool } from "../../mcp/define-tool.ts";
import { readTranscriptSession } from "../../transcripts/read.ts";
import type { TranscriptServiceOptions } from "../../transcripts/search.ts";
import type { ToolResult } from "../../shared/result.ts";

export const transcriptReadSchema = z.object({
  sessionRef: z.string().min(1).describe("transcript_search 結果中的 sessionRef。"),
  fromTurn: z.number().int().min(1).optional().describe("從第幾個回合開始，預設 1。"),
  maxTurns: z.number().int().min(1).max(50).optional().describe("最多讀幾個回合，預設 10。"),
  maxChars: z
    .number()
    .int()
    .min(100)
    .max(50_000)
    .optional()
    .describe("文字總長上限（Unicode code point），預設 20000。"),
});

export type TranscriptReadToolInput = z.infer<typeof transcriptReadSchema>;

export function createTranscriptReadHandler(
  options: TranscriptServiceOptions = {},
): (input: TranscriptReadToolInput) => ToolResult {
  return (input) => readTranscriptSession(input, options);
}

export const tool = defineTool({
  name: "transcript_read",
  title: "讀取對話紀錄",
  description:
    "讀取指定對話的回合內容；一次最多 50 個回合、50000 個字元。關閉的來源與排除的專案會被拒絕。",
  domain: "transcript",
  inputSchema: transcriptReadSchema,
  handler: createTranscriptReadHandler(),
});
