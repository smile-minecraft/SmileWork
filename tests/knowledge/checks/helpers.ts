import type { Database } from "bun:sqlite";
import type { KnowledgeKind, KnowledgeLayer } from "../../../src/domain/knowledge.ts";
import { insertTestProject } from "../../helpers/db.ts";

export interface InsertKnowledgeEntryOptions {
  knowledgeId: string;
  title: string;
  layer: KnowledgeLayer;
  projectId?: string | null;
  kind?: KnowledgeKind;
  status?: "active" | "retired";
}

/** 直接插入知識項目，讓跨層同名檢查有真實的資料庫資料可以查詢。 */
export function insertKnowledgeEntry(
  db: Database,
  options: InsertKnowledgeEntryOptions,
): void {
  const projectId = options.layer === "project" ? (options.projectId ?? "test-project") : null;
  if (projectId !== null) {
    insertTestProject(db, projectId);
  }

  const now = new Date().toISOString();
  db.query(
    `INSERT INTO knowledge_entries (
       knowledge_id, layer, project_id, kind, type, title, description, source,
       status, current_version, created_at, updated_at, created_by, updated_by
     ) VALUES (?, ?, ?, ?, 'reference', ?, '', 'test', ?, 1, ?, ?, 'tester', 'tester')`,
  ).run(
    options.knowledgeId,
    options.layer,
    projectId,
    options.kind ?? "skill",
    options.title,
    options.status ?? "active",
    now,
    now,
  );
}

/** 產生指定行數的 SKILL.md 內容；最後一行不帶換行。 */
export function markdownWithLines(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `第 ${index + 1} 行`).join("\n");
}
