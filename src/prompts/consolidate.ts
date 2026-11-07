import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { textPrompt, withPromptContext } from "./shared.ts";

export const CONSOLIDATE_SCOPES = ["project", "global", "all"] as const;
type ConsolidateScope = (typeof CONSOLIDATE_SCOPES)[number];

const argsSchema = z.object({
  scope: z.enum(CONSOLIDATE_SCOPES).default("project").describe("要整理的知識範圍"),
  projectPath: z.string().min(1).optional().describe("專案路徑；省略時依環境與 cwd 解析"),
});

function signalScopeClause(
  scope: ConsolidateScope,
  projectId: string | null,
): { sql: string; params: string[] } {
  if (scope === "global") return { sql: "scope = 'global'", params: [] };
  if (scope === "project") {
    return { sql: "scope = 'project' AND project_id = ?", params: [projectId ?? ""] };
  }
  return {
    sql: "(scope = 'global' OR (scope = 'project' AND project_id = ?))",
    params: [projectId ?? ""],
  };
}

function knowledgeScopeClause(
  scope: ConsolidateScope,
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

function countSignals(db: Database, scope: ConsolidateScope, projectId: string | null): number {
  const clause = signalScopeClause(scope, projectId);
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM signals
       WHERE status IN ('open', 'triaged') AND ${clause.sql}`,
    )
    .get(...clause.params);
  return row?.n ?? 0;
}

function countKnowledge(db: Database, scope: ConsolidateScope, projectId: string | null): number {
  const clause = knowledgeScopeClause(scope, projectId);
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM knowledge_entries
       WHERE status = 'active' AND ${clause.sql}`,
    )
    .get(...clause.params);
  return row?.n ?? 0;
}

function scopeLabel(scope: ConsolidateScope, projectId: string | null): string {
  if (scope === "global") return "global";
  if (scope === "project") return `project ${projectId ?? ""}`;
  return `all（project ${projectId ?? ""} 加 global）`;
}

/** 整理知識的提示：先看訊號與既有知識，再寫入有來源支持的內容。 */
export function renderConsolidatePrompt(input: {
  scopeLabel: string;
  signalCount: number;
  knowledgeCount: number;
}): string {
  return [
    `# 整理知識（${input.scopeLabel}）`,
    "",
    `目前有 ${input.signalCount} 筆未處理訊號、${input.knowledgeCount} 筆使用中的知識。`,
    "",
    "## 步驟",
    "1. 用 signal_list 讀取 open 與 triaged 訊號，必要時用 transcript_search、transcript_read 找原始對話。",
    "2. 用 knowledge_search 確認是否已有相同主題；重複時用 knowledge_write 的 expectedVersion 更新，不要建立重複項目。",
    "3. 只寫有來源支持的事實；在內容註明來源訊號或對話，並用 sourceSignalIds 連結。",
    "4. 寫入後用 knowledge_read 確認版本內容；需要回溯時用 knowledge_history。",
  ].join("\n");
}

export function registerConsolidatePrompt(server: McpServer): void {
  server.registerPrompt(
    "consolidate",
    {
      title: "整理知識",
      description: "整理訊號與對話紀錄，把有來源支持的內容寫成知識或更新既有版本。",
      argsSchema,
    },
    ({ scope, projectPath }) => {
      const text = withPromptContext((context) => {
        const project =
          scope === "global" ? null : context.tryResolveProject(projectPath);
        if (scope !== "global" && project === null) {
          throw new Error(
            "整理知識需要可解析的專案；請設定 SMILEWORK_PROJECT、在 git repo 內使用，或改用 scope=global。",
          );
        }
        const projectId = project?.projectId ?? null;
        const db = context.db();
        return renderConsolidatePrompt({
          scopeLabel: scopeLabel(scope, projectId),
          signalCount: countSignals(db, scope, projectId),
          knowledgeCount: countKnowledge(db, scope, projectId),
        });
      });
      return textPrompt(text);
    },
  );
}
