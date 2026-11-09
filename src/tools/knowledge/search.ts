import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  KNOWLEDGE_KINDS,
  type KnowledgeEntry,
  type ProjectContext,
} from "../../domain/index.ts";
import {
  KNOWLEDGE_ERROR_CODES,
  readKnowledgeSnapshot,
  type KnowledgeStoreOptions,
} from "../../knowledge/store.ts";
import {
  requireKnowledgeVersion,
  rowToKnowledgeEntry,
  type KnowledgeEntryRow,
} from "../../knowledge/versions.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import type { ToolContext } from "../../mcp/types.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { ok } from "../../shared/result.ts";
import {
  knowledgeStoreOptions,
  parseKnowledgeInput,
  requireKnowledgeProject,
} from "./read.ts";

const SEARCH_SCOPES = ["project", "global", "all"] as const;
const SEARCH_STATUSES = ["active", "retired", "all"] as const;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_SNIPPET_CHARS = 500;
const DEFAULT_SNIPPET_CHARS = 200;

const inputSchema = z.object({
  query: z.string().max(500).optional(),
  kind: z.enum(KNOWLEDGE_KINDS).optional(),
  status: z.enum(SEARCH_STATUSES).default("active"),
  scope: z.enum(SEARCH_SCOPES).default("all"),
  projectPath: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  snippetChars: z.number().int().min(40).max(MAX_SNIPPET_CHARS).default(DEFAULT_SNIPPET_CHARS),
});

interface SearchCandidate {
  entry: KnowledgeEntry;
  matchedIn: string[];
  score: number;
  snippet: string;
}

interface SnapshotWarning {
  knowledgeId: string;
  code: string;
  message: string;
}

function projectForScope(
  context: ToolContext,
  scope: (typeof SEARCH_SCOPES)[number],
  projectPath: string | undefined,
): ProjectContext | null {
  if (scope === "global") return null;
  if (scope === "project" || projectPath !== undefined) {
    return requireKnowledgeProject(context, projectPath);
  }
  return context.tryResolveProject();
}

function scopeClause(
  scope: (typeof SEARCH_SCOPES)[number],
  projectId: string | null,
): { sql: string; params: string[] } {
  if (scope === "global" || projectId === null) {
    return { sql: "layer = 'global'", params: [] };
  }
  if (scope === "project") {
    return { sql: "layer = 'project' AND project_id = ?", params: [projectId] };
  }
  return {
    sql: "(layer = 'global' OR (layer = 'project' AND project_id = ?))",
    params: [projectId],
  };
}

/** 擷取關鍵字附近的片段，長度含省略符號不超過 maxChars。 */
function makeSnippet(content: string, needle: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const index = needle === "" ? -1 : content.toLowerCase().indexOf(needle);
  const anchor = index < 0 ? 0 : index;
  let start = Math.max(0, anchor - Math.floor(maxChars / 2));
  const end = Math.min(content.length, start + maxChars);
  if (end === content.length) start = Math.max(0, end - maxChars);

  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  const bodyLength = maxChars - prefix.length - suffix.length;
  return `${prefix}${content.slice(start, start + bodyLength)}${suffix}`;
}

function matchScore(matchedIn: readonly string[]): number {
  let score = 0;
  if (matchedIn.includes("knowledgeId")) score += 4;
  if (matchedIn.includes("title")) score += 3;
  if (matchedIn.includes("description")) score += 2;
  if (matchedIn.includes("content")) score += 1;
  return score;
}

function readCurrentContent(
  db: Database,
  options: KnowledgeStoreOptions,
  entry: KnowledgeEntry,
  warnings: SnapshotWarning[],
): string {
  try {
    const version = requireKnowledgeVersion(db, entry.id, entry.currentVersion);
    return readKnowledgeSnapshot(version.snapshotPath, version.sha256, options);
  } catch (error) {
    if (
      error instanceof SmileworkError &&
      (error.code === KNOWLEDGE_ERROR_CODES.snapshotMissing ||
        error.code === KNOWLEDGE_ERROR_CODES.snapshotCorrupted)
    ) {
      warnings.push({
        knowledgeId: entry.knowledgeId,
        code: error.code,
        message: error.message,
      });
      return "";
    }
    throw error;
  }
}

export const tool = defineTool({
  name: "knowledge_search",
  title: "搜尋知識",
  description:
    "用子字串搜尋知識的識別碼、標題、描述與目前版本內容，只回片段與識別碼，不回全文。支援 kind、scope（project/global/all）、status 與 limit；片段長度以 snippetChars 控制。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    const query = (parsed.query ?? "").trim();
    const project = projectForScope(context, parsed.scope, parsed.projectPath);
    const db = context.db();
    const options = knowledgeStoreOptions(db);
    const scope = scopeClause(parsed.scope, project?.projectId ?? null);
    const clauses = [scope.sql];
    const params = [...scope.params];
    if (parsed.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(parsed.kind);
    }
    if (parsed.status !== "all") {
      clauses.push("status = ?");
      params.push(parsed.status);
    }

    const rows = db
      .query<KnowledgeEntryRow, string[]>(
        `SELECT * FROM knowledge_entries
         WHERE ${clauses.join(" AND ")}
         ORDER BY pinned DESC, updated_at DESC, knowledge_id`,
      )
      .all(...params);

    const needle = query.toLowerCase();
    const warnings: SnapshotWarning[] = [];
    const matched: SearchCandidate[] = [];

    for (const row of rows) {
      const entry = rowToKnowledgeEntry(row);
      const content = readCurrentContent(db, options, entry, warnings);
      const matchedIn: string[] = [];
      if (needle !== "") {
        if (entry.knowledgeId.toLowerCase().includes(needle)) matchedIn.push("knowledgeId");
        if (entry.title.toLowerCase().includes(needle)) matchedIn.push("title");
        if (entry.description.toLowerCase().includes(needle)) matchedIn.push("description");
        if (content.toLowerCase().includes(needle)) matchedIn.push("content");
        if (matchedIn.length === 0) continue;
      }
      matched.push({
        entry,
        matchedIn,
        score: matchScore(matchedIn),
        snippet: makeSnippet(content, needle, parsed.snippetChars),
      });
    }

    matched.sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.entry.pinned) - Number(left.entry.pinned) ||
        right.entry.updatedAt.localeCompare(left.entry.updatedAt) ||
        left.entry.knowledgeId.localeCompare(right.entry.knowledgeId),
    );

    const page = matched.slice(0, parsed.limit);
    const results = page.map(({ entry, matchedIn, snippet }) => ({
      entryId: entry.id,
      knowledgeId: entry.knowledgeId,
      layer: entry.layer,
      projectId: entry.projectId,
      kind: entry.kind,
      type: entry.type,
      title: entry.title,
      scopePaths: entry.scopePaths,
      status: entry.status,
      pinned: entry.pinned,
      currentVersion: entry.currentVersion,
      updatedAt: entry.updatedAt,
      matchedIn,
      snippet,
    }));

    return ok(
      query === ""
        ? `列出 ${results.length} 筆知識（共 ${matched.length} 筆）。`
        : `找到 ${matched.length} 筆知識，回傳 ${results.length} 筆片段。`,
      {
        query,
        scope: parsed.scope,
        projectId: project?.projectId ?? null,
        scanned: rows.length,
        total: matched.length,
        hasMore: matched.length > results.length,
        results,
        warnings,
      },
    );
  },
});
