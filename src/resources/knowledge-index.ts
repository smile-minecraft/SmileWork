import type { Database } from "bun:sqlite";
import { rowToKnowledgeEntry, type KnowledgeEntryRow } from "../knowledge/versions.ts";

export const KNOWLEDGE_INDEX_SCOPES = ["project", "global", "all"] as const;
export type KnowledgeIndexScope = (typeof KNOWLEDGE_INDEX_SCOPES)[number];

export function isKnowledgeIndexScope(value: string): value is KnowledgeIndexScope {
  return (KNOWLEDGE_INDEX_SCOPES as readonly string[]).includes(value);
}

function scopeClause(
  scope: KnowledgeIndexScope,
  projectId: string | null,
): { sql: string; params: string[] } {
  if (scope === "global") return { sql: "layer = 'global'", params: [] };
  if (scope === "project") {
    return { sql: "layer = 'project' AND project_id = ?", params: [projectId ?? ""] };
  }
  return {
    sql: "(layer = 'global' OR (layer = 'project' AND project_id = ?))",
    params: [projectId ?? ""],
  };
}

/** 列出使用中的知識，讓整理代理先看索引再決定要不要讀全文。 */
export function renderKnowledgeIndex(
  db: Database,
  scope: KnowledgeIndexScope,
  projectId: string | null,
): string {
  const clause = scopeClause(scope, projectId);
  const rows = db
    .query<KnowledgeEntryRow, string[]>(
      `SELECT * FROM knowledge_entries
       WHERE status = 'active' AND ${clause.sql}
       ORDER BY pinned DESC, updated_at DESC, knowledge_id`,
    )
    .all(...clause.params);
  const entries = rows.map(rowToKnowledgeEntry);

  const header =
    scope === "global"
      ? "# 知識索引（global）"
      : scope === "project"
        ? `# 知識索引（project ${projectId ?? ""}）`
        : `# 知識索引（all，project ${projectId ?? ""}）`;

  const lines = [header, "", `共 ${entries.length} 筆使用中的知識。`];
  if (entries.length === 0) {
    lines.push("", "目前沒有知識項目。");
    return lines.join("\n");
  }

  lines.push("");
  for (const entry of entries) {
    const pinned = entry.pinned ? "，pinned" : "";
    const description = entry.description === "" ? "" : ` — ${entry.description}`;
    lines.push(
      `- \`${entry.knowledgeId}\`（${entry.layer}/${entry.kind}/${entry.type}，v${entry.currentVersion}${pinned}）${entry.title}${description}`,
    );
  }
  return lines.join("\n");
}
