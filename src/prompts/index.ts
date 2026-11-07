/** MCP prompts：派工簡報、獨立審查與知識整理。 */

import type { McpServer } from "@modelcontextprotocol/server";
import { registerBriefPrompt } from "./brief.ts";
import { registerConsolidatePrompt } from "./consolidate.ts";
import { registerReviewPrompt } from "./review.ts";

export const PROMPT_NAMES = ["brief", "review", "consolidate"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export function registerPrompts(server: McpServer): void {
  registerBriefPrompt(server);
  registerReviewPrompt(server);
  registerConsolidatePrompt(server);
}
