import { z } from "zod";
import { KNOWLEDGE_LAYERS } from "../../domain/index.ts";
import { diffKnowledgeVersions, listKnowledgeVersions } from "../../knowledge/store.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { ok } from "../../shared/result.ts";
import {
  knowledgeEntryView,
  knowledgeStoreOptions,
  knowledgeVersionView,
  parseKnowledgeInput,
  requireKnowledgeEntryForTool,
} from "./read.ts";

const inputSchema = z.object({
  knowledgeId: z.string().min(1).max(200),
  layer: z.enum(KNOWLEDGE_LAYERS).default("project"),
  projectPath: z.string().min(1).optional(),
});

export const tool = defineTool({
  name: "knowledge_history",
  title: "查看知識歷史",
  description:
    "列出知識的每個版本、與前一版的 unified diff、作者、理由與來源訊號。第一版會和空內容比較；不記錄使用事件。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    const entry = requireKnowledgeEntryForTool(context, parsed);
    const db = context.db();
    const options = knowledgeStoreOptions(db);
    const versions = listKnowledgeVersions(db, entry.id).map((version) => {
      const diff = diffKnowledgeVersions(db, entry.id, version.version, options);
      return {
        ...knowledgeVersionView(version),
        previousVersion: diff.previousVersion,
        diff: diff.diff,
      };
    });

    return ok(`知識 ${entry.knowledgeId} 共有 ${versions.length} 個版本。`, {
      entry: knowledgeEntryView(entry),
      total: versions.length,
      versions,
    });
  },
});
