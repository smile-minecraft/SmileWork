import type { Database } from "bun:sqlite";
import type { KnowledgeEntry, KnowledgeLayer, KnowledgeType } from "../domain/knowledge.ts";
import { rowToKnowledgeEntry, type KnowledgeEntryRow } from "./versions.ts";

export interface RelevantKnowledge {
  knowledgeId: string;
  type: KnowledgeType;
  layer: KnowledgeLayer;
  title: string;
  description: string;
  scopePaths: string[];
}

export interface FindRelevantKnowledgeOptions {
  limit?: number;
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * 知識的 scopePaths 是 glob，工作的 scopePaths 通常是實際的檔案或資料夾。
 * 沒有萬用字元時雙向接受「路徑本身或上層資料夾」；有萬用字元時用 Bun.Glob，
 * 並額外接受工作的資料夾是 glob 靜態前綴的情況。
 */
export function globMatchesPath(pattern: string, path: string): boolean {
  const glob = normalizePath(pattern);
  const target = normalizePath(path);
  if (glob === "" || target === "") return false;

  if (!/[*?[\]{}]/.test(glob)) {
    return target === glob || target.startsWith(`${glob}/`) || glob.startsWith(`${target}/`);
  }

  try {
    const matcher = new Bun.Glob(glob);
    if (matcher.match(target) || matcher.match(`${target}/`)) return true;
    const staticPrefix = glob.split(/[*?[\]{}]/, 1)[0]!.replace(/\/+$/, "");
    return (
      staticPrefix !== "" &&
      (staticPrefix === target || staticPrefix.startsWith(`${target}/`))
    );
  } catch {
    return false;
  }
}

function layerRank(layer: KnowledgeLayer): number {
  return layer === "project" ? 0 : 1;
}

function typeRank(type: KnowledgeType): number {
  if (type === "decision") return 0;
  if (type === "pitfall") return 1;
  return 2;
}

function toRelevant(entry: KnowledgeEntry): RelevantKnowledge {
  return {
    knowledgeId: entry.knowledgeId,
    type: entry.type,
    layer: entry.layer,
    title: entry.title,
    description: entry.description.trim() === "" ? entry.title : entry.description.trim(),
    scopePaths: entry.scopePaths,
  };
}

/**
 * 找出和這筆工作 scopePaths 對得上的 decision/pitfall 知識。
 * 只讀 active、有 scopePaths 的項目；project 層優先於 global 層。
 */
export function findRelevantKnowledge(
  db: Database,
  projectId: string,
  workScopePaths: readonly string[],
  options: FindRelevantKnowledgeOptions = {},
): RelevantKnowledge[] {
  if (workScopePaths.length === 0) return [];

  const rows = db
    .query<KnowledgeEntryRow, [string]>(
      `SELECT * FROM knowledge_entries
       WHERE status = 'active'
         AND type IN ('decision', 'pitfall')
         AND scope_paths <> '[]'
         AND (layer = 'global' OR (layer = 'project' AND project_id = ?))`,
    )
    .all(projectId);

  const matched = rows
    .map(rowToKnowledgeEntry)
    .filter((entry) =>
      entry.scopePaths.some((scopePath) =>
        workScopePaths.some((workPath) => globMatchesPath(scopePath, workPath)),
      ),
    )
    .sort(
      (left, right) =>
        layerRank(left.layer) - layerRank(right.layer) ||
        Number(right.pinned) - Number(left.pinned) ||
        typeRank(left.type) - typeRank(right.type) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.knowledgeId.localeCompare(right.knowledgeId),
    );

  return matched.slice(0, options.limit ?? 10).map(toRelevant);
}
