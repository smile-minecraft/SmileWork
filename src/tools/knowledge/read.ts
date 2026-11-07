import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { z, type ZodType } from "zod";
import {
  KNOWLEDGE_LAYERS,
  type KnowledgeEntry,
  type KnowledgeLayer,
  type KnowledgeVersion,
  type ProjectContext,
} from "../../domain/index.ts";
import {
  findKnowledgeEntry,
  getKnowledgeUsageStats,
  KNOWLEDGE_ERROR_CODES,
  readKnowledgeVersion,
  recordKnowledgeUsage,
  type KnowledgeStoreOptions,
} from "../../knowledge/store.ts";
import { isProjectResolutionError } from "../../mcp/context.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import type { ToolContext } from "../../mcp/types.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { ok } from "../../shared/result.ts";

/** 知識讀取類工具對外的錯誤碼；外框的 code 直接使用這些值。 */
export const KNOWLEDGE_TOOL_ERROR_CODES = {
  validation: "VALIDATION_ERROR",
  projectUnresolved: "PROJECT_UNRESOLVED",
  contentTooLarge: "KNOWLEDGE_CONTENT_TOO_LARGE",
} as const;

const DEFAULT_MAX_CHARS = 100_000;
const HARD_MAX_CHARS = 1_000_000;

/**
 * 知識快照放在 SMILEWORK_HOME 下，和資料庫同一個家目錄。
 * 工具 context 只帶資料庫連線，所以從資料庫檔位置回推快照根目錄，
 * 避免測試或多個 home 同時存在時誤用 process.env。
 */
export function knowledgeStoreOptions(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeStoreOptions {
  const filename = db.filename;
  if (!filename || filename === ":memory:") return { env };
  return { storeRoot: join(dirname(filename), "knowledge-store") };
}

/** 把工具輸入換成固定錯誤碼，讓 MCP 外框不必猜測驗證失敗的原因。 */
export function parseKnowledgeInput<TSchema extends ZodType>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const detail = issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("；");
  throw new SmileworkError(
    KNOWLEDGE_TOOL_ERROR_CODES.validation,
    `知識工具參數不正確：${detail}`,
    "依錯誤訊息修正參數後重新呼叫。",
    { issues },
  );
}

export function requireKnowledgeProject(
  context: ToolContext,
  projectPath?: string,
): ProjectContext {
  try {
    return context.resolveProject(projectPath);
  } catch (error) {
    if (error instanceof SmileworkError && isProjectResolutionError(error)) {
      throw new SmileworkError(
        KNOWLEDGE_TOOL_ERROR_CODES.projectUnresolved,
        error.message,
        error.nextAction,
        error.data,
      );
    }
    throw error;
  }
}

export interface KnowledgeTargetInput {
  knowledgeId: string;
  layer: KnowledgeLayer;
  projectPath?: string;
}

/** 依 knowledgeId、layer 與目前的專案找出唯一項目；找不到就回固定錯誤。 */
export function requireKnowledgeEntryForTool(
  context: ToolContext,
  target: KnowledgeTargetInput,
): KnowledgeEntry {
  const projectId =
    target.layer === "project"
      ? requireKnowledgeProject(context, target.projectPath).projectId
      : null;
  const entry = findKnowledgeEntry(context.db(), target.knowledgeId, target.layer, projectId);
  if (!entry) {
    throw new SmileworkError(
      KNOWLEDGE_ERROR_CODES.entryNotFound,
      `找不到知識項目：${target.knowledgeId}（${target.layer}）`,
      "先用 knowledge_search 確認知識 ID 與 layer，再呼叫這個工具。",
      { knowledgeId: target.knowledgeId, layer: target.layer, projectId },
    );
  }
  return entry;
}

/** 工具回傳用的 entry 摘要。 */
export function knowledgeEntryView(entry: KnowledgeEntry) {
  return {
    id: entry.knowledgeId,
    entryId: entry.id,
    layer: entry.layer,
    projectId: entry.projectId,
    kind: entry.kind,
    type: entry.type,
    title: entry.title,
    description: entry.description,
    tags: entry.tags,
    pinned: entry.pinned,
    source: entry.source,
    status: entry.status,
    currentVersion: entry.currentVersion,
    workId: entry.workId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** 工具回傳用的版本摘要；快照路徑是內部細節，不對外暴露。 */
export function knowledgeVersionView(version: KnowledgeVersion) {
  return {
    version: version.version,
    sha256: version.sha256,
    bytes: version.bytes,
    actor: version.actor,
    actorModel: version.actorModel,
    reason: version.reason,
    sourceSignalIds: version.sourceSignalIds,
    workId: version.workId,
    createdAt: version.createdAt,
  };
}

const inputSchema = z.object({
  knowledgeId: z.string().min(1).max(200),
  layer: z.enum(KNOWLEDGE_LAYERS).default("project"),
  version: z.number().int().min(1).optional(),
  projectPath: z.string().min(1).optional(),
  maxChars: z.number().int().min(1).max(HARD_MAX_CHARS).default(DEFAULT_MAX_CHARS),
});

export const tool = defineTool({
  name: "knowledge_read",
  title: "讀取知識",
  description:
    "讀取知識全文與指定版本（預設目前版本），並記錄一筆使用事件。全文超過 maxChars（預設 100000，上限 1000000 字元）時拒絕，請改用 knowledge_search 取得片段。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    const entry = requireKnowledgeEntryForTool(context, parsed);
    const db = context.db();
    const options = knowledgeStoreOptions(db);
    const versionNumber = parsed.version ?? entry.currentVersion;
    const result = readKnowledgeVersion(db, entry.id, versionNumber, {
      ...options,
      recordUsage: false,
    });

    if (result.content.length > parsed.maxChars) {
      throw new SmileworkError(
        KNOWLEDGE_TOOL_ERROR_CODES.contentTooLarge,
        `知識 ${entry.knowledgeId} 的版本 ${versionNumber} 有 ${result.content.length} 字元，超過單次讀取上限 ${parsed.maxChars}。`,
        "提高 maxChars（最多 1000000）或改用 knowledge_search 讀取片段。",
        {
          knowledgeId: entry.knowledgeId,
          version: versionNumber,
          contentChars: result.content.length,
          maxChars: parsed.maxChars,
          contentBytes: result.version.bytes,
        },
      );
    }

    recordKnowledgeUsage(db, {
      knowledgeId: result.entry.knowledgeId,
      projectId: result.entry.projectId,
      layer: result.entry.layer,
      version: result.version.version,
      action: "read",
      actor: context.actor.name,
      actorModel: context.actor.model,
      query: null,
    });

    return ok(`已讀取知識 ${result.entry.knowledgeId} 的版本 ${result.version.version}。`, {
      entry: knowledgeEntryView(result.entry),
      version: knowledgeVersionView(result.version),
      content: result.content,
      contentBytes: result.version.bytes,
      usage: getKnowledgeUsageStats(db, result.entry.id),
    });
  },
});
