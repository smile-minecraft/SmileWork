import type { KnowledgeType } from "../../domain/knowledge.ts";
import { parseSkillFrontmatter as parseCheckSkillFrontmatter } from "../checks/frontmatter.ts";

export interface MemoryDocumentInput {
  title: string;
  description: string;
  type: KnowledgeType;
  pinned: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string;
  content: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** 記憶檔沿用舊格式的八個 frontmatter 欄位，內容只放呼叫端提供的本文。 */
export function formatMemoryDocument(input: MemoryDocumentInput): string {
  const body = input.content.replace(/\r\n?/g, "\n").trimEnd();
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `description: ${yamlString(input.description)}`,
    `type: ${yamlString(input.type)}`,
    `pinned: ${input.pinned ? "true" : "false"}`,
    `source: ${yamlString(input.source)}`,
    `created: ${yamlString(input.createdAt)}`,
    `updated: ${yamlString(input.updatedAt)}`,
    `verified_at: ${yamlString(input.verifiedAt)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
}

/**
 * 沿用靜態檢查的 frontmatter 解析，讓工具補 title/description 時
 * 與 `checkKnowledgeWrite` 看到的值完全一致。
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const parsed = parseCheckSkillFrontmatter(content);
  return {
    name: parsed.name ?? null,
    description: parsed.description ?? null,
  };
}
