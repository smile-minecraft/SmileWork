import type { McpServer } from "@modelcontextprotocol/server";
import { tool as workCreate } from "../tools/work/create.ts";
import { tool as workGet } from "../tools/work/get.ts";
import { tool as workList } from "../tools/work/list.ts";
import { tool as workReady } from "../tools/work/ready.ts";
import { tool as workUpdate } from "../tools/work/update.ts";
import { tool as workComplete } from "../tools/work/complete.ts";
import { tool as workReview } from "../tools/work/review.ts";
import { tool as verifyRun } from "../tools/verify/verify-run.ts";
import { tool as status } from "../tools/status/status.ts";
import { tool as signalNote } from "../tools/signal/note.ts";
import { tool as signalList } from "../tools/signal/list.ts";
import { tool as signalMark } from "../tools/signal/mark.ts";
import { tool as knowledgeSearch } from "../tools/knowledge/search.ts";
import { tool as knowledgeRead } from "../tools/knowledge/read.ts";
import { tool as knowledgeWrite } from "../tools/knowledge/write.ts";
import { tool as knowledgeRetire } from "../tools/knowledge/retire.ts";
import { tool as knowledgePromote } from "../tools/knowledge/promote.ts";
import { tool as knowledgeHistory } from "../tools/knowledge/history.ts";
import { tool as knowledgeRevert } from "../tools/knowledge/revert.ts";
import { tool as transcriptSearch } from "../tools/transcript/search.ts";
import { tool as transcriptRead } from "../tools/transcript/read.ts";
import { runTool } from "./result.ts";
import { TOOL_NAMES } from "./tool-names.ts";
import type { ToolDefinition, ToolDomain } from "./types.ts";
import { passThroughInputSchema } from "./validation.ts";

/** 工具名稱清單的單一來源在 tool-names.ts；registry 對外轉出，並驗證與定義一致。 */
export { TOOL_NAMES };

/** 六個領域是工具掛載點的固定分組。 */
export const TOOLS_BY_DOMAIN: Readonly<Record<ToolDomain, readonly ToolDefinition[]>> = {
  work: [workCreate, workGet, workList, workReady, workUpdate, workComplete, workReview],
  verify: [verifyRun],
  status: [status],
  signal: [signalNote, signalList, signalMark],
  knowledge: [
    knowledgeSearch,
    knowledgeRead,
    knowledgeWrite,
    knowledgeRetire,
    knowledgePromote,
    knowledgeHistory,
    knowledgeRevert,
  ],
  transcript: [transcriptSearch, transcriptRead],
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.values(TOOLS_BY_DOMAIN).flat();

/**
 * tool-names.ts 是工具名稱的單一來源；定義與清單的名稱和順序必須完全一致，
 * 漂移時在模組初始化就丟出錯誤，而不是等到掛載工具或測試才發現。
 */
const DEFINITION_TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);
if (
  DEFINITION_TOOL_NAMES.length !== TOOL_NAMES.length ||
  DEFINITION_TOOL_NAMES.some((name, index) => name !== TOOL_NAMES[index])
) {
  throw new Error(
    `registry 工具定義與 TOOL_NAMES 不一致：定義為 ${DEFINITION_TOOL_NAMES.join("、")}，清單為 ${TOOL_NAMES.join("、")}。`,
  );
}

const TOOLS_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

if (TOOLS_BY_NAME.size !== TOOL_DEFINITIONS.length) {
  throw new Error("工具名稱重複，registry 無法載入。");
}

export function toolByName(name: string): ToolDefinition | null {
  return TOOLS_BY_NAME.get(name) ?? null;
}

/** 把目前 registry 的全部工具註冊到 MCP 伺服器。 */
export function registerTools(server: McpServer): void {
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: passThroughInputSchema(tool.inputSchema),
      },
      async (input: unknown) => runTool(tool, (input ?? {}) as Record<string, unknown>),
    );
  }
}
