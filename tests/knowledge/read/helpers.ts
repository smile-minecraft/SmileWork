import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDatabase } from "../../../src/db/index.ts";
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLayer,
  KnowledgeStatus,
  KnowledgeType,
  ProjectContext,
} from "../../../src/domain/index.ts";
import {
  createKnowledgeEntry,
  getKnowledgeUsageStats,
  readKnowledgeVersion,
  updateKnowledgeEntry,
  type KnowledgeUsageStats,
} from "../../../src/knowledge/store.ts";
import {
  materializeKnowledge,
  type KnowledgeAuxFile,
  type MemoryMetadata,
} from "../../../src/knowledge/materialize/index.ts";
import { runTool } from "../../../src/mcp/result.ts";
import type { ToolDefinition } from "../../../src/mcp/types.ts";
import { registerProject } from "../../../src/project/registry.ts";
import { resolveProject } from "../../../src/project/resolve.ts";
import type { ToolResult, ToolSuccess } from "../../../src/shared/result.ts";
import { createGitRepo } from "../../helpers/git.ts";
import { withTempHome } from "../../helpers/temp.ts";

export interface KnowledgeFixture {
  home: string;
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  project: ProjectContext;
}

/** 每個測試使用自己的暫存 SMILEWORK_HOME 與 HOME，不碰真實使用者資料。 */
export async function withKnowledgeFixture(
  run: (fixture: KnowledgeFixture) => Promise<void>,
): Promise<void> {
  await withTempHome("knowledge-tools", async (home, root) => {
    const repo = await createGitRepo(`${root}/repo`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: `${root}/home`,
      SMILEWORK_HOME: home,
      SMILEWORK_PROJECT: repo,
      SMILEWORK_ACTOR: "build",
      SMILEWORK_MODEL: "test-model",
    };
    const project = resolveProject({ explicitPath: repo, env });
    await run({ home, root, repo, env, project });
  });
}

export interface SeedKnowledgeInput {
  knowledgeId: string;
  content: string;
  kind?: KnowledgeKind;
  type?: KnowledgeType;
  layer?: KnowledgeLayer;
  title?: string;
  description?: string;
  reason?: string;
  sourceSignalIds?: readonly string[];
  status?: KnowledgeStatus;
}

/** 直接透過儲存層建立知識項目，模擬其他工具寫入後的資料。 */
export function seedKnowledge(
  fixture: KnowledgeFixture,
  input: SeedKnowledgeInput,
): KnowledgeEntry {
  const db = openDatabase({ home: fixture.home });
  try {
    registerProject(db, fixture.project);
    const layer = input.layer ?? "project";
    return createKnowledgeEntry(
      db,
      {
        knowledgeId: input.knowledgeId,
        layer,
        projectId: layer === "project" ? fixture.project.projectId : null,
        kind: input.kind ?? "memory",
        type: input.type ?? "lesson",
        title: input.title ?? input.knowledgeId,
        description: input.description ?? "",
        content: input.content,
        status: input.status,
        actor: "build",
        actorModel: "test-model",
        reason: input.reason ?? "初始版本",
        sourceSignalIds: input.sourceSignalIds ?? [],
      },
      { env: fixture.env },
    );
  } finally {
    db.close();
  }
}

export interface AppendVersionOptions {
  reason?: string;
  sourceSignalIds?: readonly string[];
}

/** 追加一個版本，回傳更新後的 entry。 */
export function appendVersion(
  fixture: KnowledgeFixture,
  entryId: number,
  content: string,
  options: AppendVersionOptions = {},
): KnowledgeEntry {
  const db = openDatabase({ home: fixture.home });
  try {
    return updateKnowledgeEntry(
      db,
      entryId,
      {
        content,
        actor: "build",
        actorModel: "test-model",
        reason: options.reason,
        sourceSignalIds: options.sourceSignalIds,
      },
      { env: fixture.env },
    );
  } finally {
    db.close();
  }
}

export interface MaterializeExistingOptions {
  files?: readonly KnowledgeAuxFile[];
  /** 專案技能所在的 worktree；預設測試用的主 checkout。 */
  projectPath?: string;
}

function memoryMetadata(entry: KnowledgeEntry): MemoryMetadata {
  return {
    title: entry.title,
    description: entry.description,
    type: entry.type,
    pinned: entry.pinned,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    verifiedAt: entry.updatedAt,
  };
}

/** 用儲存層的版本內容寫出落地檔，模擬寫入工具建立或更新後的狀態。 */
export function materializeEntry(
  fixture: KnowledgeFixture,
  entry: KnowledgeEntry,
  content: string,
  options: MaterializeExistingOptions = {},
): void {
  if (entry.kind === "document") return;
  materializeKnowledge({
    kind: entry.kind,
    layer: entry.layer,
    projectId: entry.projectId,
    knowledgeId: entry.knowledgeId,
    content,
    files: options.files ?? [],
    home: join(fixture.root, "home"),
    smileworkHome: fixture.home,
    projectPath:
      entry.layer === "project" ? (options.projectPath ?? fixture.repo) : null,
    ...(entry.kind === "memory" ? { memory: memoryMetadata(entry) } : {}),
    mode: "update",
  });
}

export function readVersionContent(
  fixture: KnowledgeFixture,
  entryId: number,
  version: number,
): string {  const db = openDatabase({ home: fixture.home });
  try {
    return readKnowledgeVersion(db, entryId, version, {
      env: fixture.env,
      recordUsage: false,
    }).content;
  } finally {
    db.close();
  }
}

export function usageStats(fixture: KnowledgeFixture, entryId: number): KnowledgeUsageStats {
  const db = openDatabase({ home: fixture.home });
  try {
    return getKnowledgeUsageStats(db, entryId);
  } finally {
    db.close();
  }
}

export function withDatabase<T>(
  fixture: KnowledgeFixture,
  run: (db: Database) => T,
): T {
  const db = openDatabase({ home: fixture.home });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 從 MCP 外框取出工具回傳的 JSON，和宿主看到的內容一致。 */
export async function callTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  fixture: KnowledgeFixture,
): Promise<ToolResult> {
  const result = await runTool(tool, input, { env: fixture.env, cwd: fixture.repo });
  const block = result.content[0];
  const text = block?.type === "text" ? block.text : "";
  return JSON.parse(text) as ToolResult;
}

export function dataOf<T>(result: ToolResult): T {
  if (!result.ok) throw new Error(`工具回傳失敗：${result.code} ${result.message}`);
  return (result as ToolSuccess<T>).data;
}

export function failureOf(result: ToolResult): { code: string; message: string; data: Record<string, unknown> } {
  if (result.ok) throw new Error("預期工具回傳失敗，但得到成功結果。");
  return { code: result.code, message: result.message, data: result.data };
}
