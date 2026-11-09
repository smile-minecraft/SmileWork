import { z } from "zod";
import {
  KNOWLEDGE_LAYERS,
  KNOWLEDGE_TYPES,
  type KnowledgeEntry,
  type KnowledgeType,
} from "../../domain/knowledge.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import {
  findKnowledgeEntry,
  requireKnowledgeVersion,
  updateKnowledgeEntry,
  createKnowledgeEntry,
} from "../../knowledge/store.ts";
import { assertKnowledgeEntryVersion } from "../../knowledge/versions.ts";
import {
  discardMaterialized,
  findProjectSkillLocations,
  invalidKnowledgeInput,
  knowledgeStoreOptions,
  materializeKnowledge,
  normalizeRelativeFilePath,
  parseKnowledgeInput,
  parseSkillFrontmatter,
  readKnowledgeIdempotentReplay,
  requireKnowledgeProject,
  requireProjectSkillLocation,
  optionalKnowledgeProject,
  resolveUserHome,
  runKnowledgeIdempotent,
  runKnowledgeWriteChecks,
  smileworkHomeForDatabase,
  throwIfChecksFailed,
  type KnowledgeAuxFile,
  type MaterializeResult,
  type MemoryMetadata,
} from "../../knowledge/materialize/index.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { ok } from "../../shared/result.ts";

const fileSchema = z.object({
  path: z.string().max(512),
  content: z.string(),
});

const inputSchema = z.object({
  kind: z.enum(["memory", "skill"]),
  layer: z.enum(KNOWLEDGE_LAYERS).default("project"),
  knowledgeId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "knowledgeId 只能用英文字母、數字、句點、底線與連字號，且必須以英文字母或數字開頭。",
    ),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(1024).default(""),
  type: z.enum(KNOWLEDGE_TYPES).optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  scopePaths: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  source: z.string().trim().min(1).max(200).optional(),
  content: z.string().min(1),
  files: z.array(fileSchema).max(100).optional(),
  expectedVersion: z.number().int().min(1).optional(),
  sourceSignalIds: z.array(z.string().min(1).max(256)).max(100).default([]),
  reason: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  projectPath: z.string().min(1).optional(),
});

type WriteInput = z.infer<typeof inputSchema>;

interface WriteOutcome {
  entry: KnowledgeEntry;
  version: ReturnType<typeof requireKnowledgeVersion>;
  artifactPath: string;
  files: Array<{ path: string; absolutePath: string; bytes: number }>;
  warnings: Array<{ code: string; field: string; message: string; path?: string; line?: number }>;
  idempotentReplay: boolean;
}

function normalizeFiles(
  files: readonly { path: string; content: string }[],
  kind: "memory" | "skill",
): KnowledgeAuxFile[] {
  const seen = new Set<string>();
  return files.map((file, index) => {
    const field = `files[${index}].path`;
    const path = normalizeRelativeFilePath(file.path, field);
    if (kind === "skill" && path.toLowerCase() === "skill.md") {
      throw invalidKnowledgeInput(
        `附檔路徑不能使用保留名稱 SKILL.md（不分大小寫）：${file.path}`,
        "技能主檔由 content 寫入；附檔請改用其他名稱。",
        { field, path: file.path },
      );
    }
    if (seen.has(path)) {
      throw invalidKnowledgeInput(`附檔路徑重複：${path}`, "每個附檔只能出現一次。", {
        field,
        path,
      });
    }
    seen.add(path);
    return { path, content: file.content };
  });
}

function normalizeScopePaths(values: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (
      value === "" ||
      value.startsWith("/") ||
      /^[A-Za-z]:\//.test(value) ||
      value.split("/").includes("..")
    ) {
      throw invalidKnowledgeInput(
        `scopePaths 必須是專案內的相對路徑 glob：${raw}`,
        "使用像 src/work/** 的相對於專案根目錄路徑，不要用絕對路徑或 ..。",
        { field: "scopePaths", value: raw },
      );
    }
    result.add(value);
  }
  return [...result].sort();
}

function assertContentNotEmpty(content: string): void {
  if (content.trim().length === 0) {
    throw invalidKnowledgeInput("content 不能是空白。", "提供實際的 Markdown 內容。", {
      field: "content",
    });
  }
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

function assertUpdatable(existing: KnowledgeEntry, input: WriteInput, type: KnowledgeType): void {
  if (existing.status === "retired") {
    throw new SmileworkError(
      "KNOWLEDGE_RETIRED",
      `知識項目 ${input.knowledgeId} 已經退役，不能直接改寫。`,
      "建立新的知識項目，或先從歷史版本確認是否要還原。",
      { knowledgeId: input.knowledgeId, layer: input.layer, entryId: existing.id },
    );
  }
  if (existing.kind !== input.kind) {
    throw invalidKnowledgeInput(
      `知識項目 ${input.knowledgeId} 的 kind 是 ${existing.kind}，不能改成 ${input.kind}。`,
      "換一個 knowledgeId，或建立新的知識項目。",
      { field: "kind", existing: existing.kind, requested: input.kind },
    );
  }
  if (existing.type !== type) {
    throw invalidKnowledgeInput(
      `知識項目 ${input.knowledgeId} 的 type 是 ${existing.type}，不能改成 ${type}。`,
      "換一個 knowledgeId，或建立新的知識項目。",
      { field: "type", existing: existing.type, requested: type },
    );
  }
}

export const tool = defineTool({
  name: "knowledge_write",
  title: "寫入知識",
  description:
    "寫入記憶或技能，落地成宿主載入的實體檔案並建立版本。支援 global/project 兩層、scopePaths 適用路徑 glob、技能附檔、expectedVersion 樂觀鎖、來源訊號、理由與 idempotencyKey。更新技能時省略 files 會保留舊附檔；明確傳 files:[] 會清空附檔；傳非空清單則視為完整集合，刪除未列出的附檔。技能附檔不能使用保留名稱 SKILL.md（不分大小寫）。v1 限制：附檔只落地成實體檔案，不進版本快照；版本只保存 content。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    assertContentNotEmpty(parsed.content);

    const db = context.db();
    const smileworkHome = smileworkHomeForDatabase(db);
    const home = resolveUserHome(smileworkHome);
    const frontmatter =
      parsed.kind === "skill" ? parseSkillFrontmatter(parsed.content) : null;
    const files = parsed.files === undefined ? null : normalizeFiles(parsed.files, parsed.kind);

    const project =
      parsed.layer === "project"
        ? requireKnowledgeProject(context, parsed.projectPath)
        : null;
    const checkProject =
      parsed.layer === "global" && parsed.kind === "skill"
        ? optionalKnowledgeProject(context, parsed.projectPath)
        : project;

    const projectId = project?.projectId ?? null;
    const projectPath = project?.worktreePath ?? null;
    const sourceSignalIds = [...new Set(parsed.sourceSignalIds)].sort();
    const tags = parsed.tags === undefined ? null : [...new Set(parsed.tags)].sort();
    const scopePaths =
      parsed.scopePaths === undefined ? null : normalizeScopePaths(parsed.scopePaths);

    const request = {
      kind: parsed.kind,
      layer: parsed.layer,
      projectId,
      knowledgeId: parsed.knowledgeId,
      title: parsed.title ?? null,
      description: parsed.description,
      type: parsed.type ?? null,
      pinned: parsed.pinned ?? null,
      tags,
      scopePaths,
      source: parsed.source ?? null,
      content: parsed.content,
      files,
      expectedVersion: parsed.expectedVersion ?? null,
      sourceSignalIds,
      reason: parsed.reason ?? null,
    };

    const idempotencyOptions = {
      projectKey: projectId ?? "",
      key: parsed.idempotencyKey,
      request,
      tool: "knowledge_write",
    };
    const replay = readKnowledgeIdempotentReplay<WriteOutcome>(db, idempotencyOptions);
    if (replay) {
      return ok(`知識項目 ${replay.entry.knowledgeId} 已存在，回傳原本的寫入結果。`, {
        ...replay,
        idempotentReplay: true,
      });
    }

    let materialized: MaterializeResult | null = null;
    let createdEntry = false;

    try {
      const outcome = runKnowledgeIdempotent<WriteOutcome>(
        db,
        idempotencyOptions,
        () => {
          const existing = findKnowledgeEntry(
            db,
            parsed.knowledgeId,
            parsed.layer,
            projectId,
          );
          const effectiveType: KnowledgeType = existing
            ? (parsed.type ?? existing.type)
            : (parsed.type ?? (parsed.kind === "skill" ? "document" : "reference"));
          const effectiveTitle = existing
            ? (parsed.title ?? existing.title)
            : (parsed.title ?? frontmatter?.name ?? parsed.knowledgeId);
          const effectiveDescription = existing
            ? parsed.description.trim().length > 0
              ? parsed.description
              : (frontmatter?.description ?? existing.description)
            : parsed.description.trim().length > 0
              ? parsed.description
              : (frontmatter?.description ?? "");
          const effectivePinned = existing
            ? (parsed.pinned ?? existing.pinned)
            : (parsed.pinned ?? false);
          const effectiveSource = existing
            ? (parsed.source ?? existing.source)
            : (parsed.source ?? "manual");
          const effectiveTags = existing
            ? (tags ?? existing.tags)
            : (tags ?? []);
          const effectiveScopePaths = existing
            ? (scopePaths ?? existing.scopePaths)
            : (scopePaths ?? []);
          const filesToWrite = files ?? [];
          const filesProvided = files !== null;

          const check = runKnowledgeWriteChecks(
            {
              kind: parsed.kind,
              layer: parsed.layer,
              projectId: checkProject?.projectId ?? null,
              knowledgeId: parsed.knowledgeId,
              title: effectiveTitle,
              description: effectiveDescription,
              source: effectiveSource,
              tags: effectiveTags,
              reason: parsed.reason,
              sourceSignalIds,
              content: parsed.content,
              files: filesToWrite,
            },
            db,
          );
          throwIfChecksFailed(check);

          const storeOptions = knowledgeStoreOptions(smileworkHome);
          let artifactProjectPath = projectPath;

          let entry: KnowledgeEntry;
          let versionNumber: number;

          if (existing) {
            assertUpdatable(existing, parsed, effectiveType);
            if (parsed.expectedVersion === undefined) {
              throw new SmileworkError(
                "KNOWLEDGE_ALREADY_EXISTS",
                `知識項目 ${parsed.knowledgeId} 已經存在（${parsed.layer}）。`,
                "先讀取既有項目，帶 expectedVersion 再更新；或換一個 knowledgeId。",
                {
                  knowledgeId: parsed.knowledgeId,
                  layer: parsed.layer,
                  entryId: existing.id,
                  currentVersion: existing.version,
                },
              );
            }
            assertKnowledgeEntryVersion(existing, parsed.expectedVersion);

            if (parsed.layer === "project" && parsed.kind === "skill") {
              if (projectId === null) {
                throw invalidKnowledgeInput(
                  "專案技能缺少 projectId。",
                  "先解析專案後再更新技能。",
                  { field: "layer" },
                );
              }
              const location = requireProjectSkillLocation(
                db,
                projectId,
                parsed.knowledgeId,
                projectPath ?? undefined,
              );
              if (location) artifactProjectPath = location.worktreePath;
            }

            entry = updateKnowledgeEntry(
              db,
              existing.id,
              {
                content: parsed.content,
                actor: context.actor.name,
                actorModel: context.actor.model,
                reason: parsed.reason,
                sourceSignalIds,
                expectedVersion: parsed.expectedVersion,
                title: effectiveTitle,
                description: effectiveDescription,
                pinned: effectivePinned,
                source: effectiveSource,
                tags: effectiveTags,
                scopePaths: effectiveScopePaths,
              },
              storeOptions,
            );
            versionNumber = entry.currentVersion;
          } else {
            createdEntry = true;
            entry = createKnowledgeEntry(
              db,
              {
                knowledgeId: parsed.knowledgeId,
                layer: parsed.layer,
                projectId,
                kind: parsed.kind,
                type: effectiveType,
                title: effectiveTitle,
                description: effectiveDescription,
                pinned: effectivePinned,
                source: effectiveSource,
                tags: effectiveTags,
                scopePaths: effectiveScopePaths,
                content: parsed.content,
                actor: context.actor.name,
                actorModel: context.actor.model,
                reason: parsed.reason,
                sourceSignalIds,
              },
              storeOptions,
            );
            versionNumber = entry.currentVersion;
          }

          if (
            createdEntry &&
            parsed.layer === "project" &&
            parsed.kind === "skill" &&
            projectId !== null
          ) {
            const existingLocations = findProjectSkillLocations(
              db,
              projectId,
              parsed.knowledgeId,
              projectPath ?? undefined,
            );
            if (existingLocations.length > 0) {
              throw invalidKnowledgeInput(
                `專案技能 ${parsed.knowledgeId} 已經存在於其他 worktree，不能再建立第二份。`,
                "先確認哪個 worktree 的既有技能是正確來源；移除重複資料夾，或改用更新既有項目的方式。",
                {
                  field: "files",
                  path: existingLocations[0]?.artifactPath,
                  knowledgeId: parsed.knowledgeId,
                  projectId,
                  worktrees: existingLocations.map((location) => location.worktreePath),
                },
              );
            }
          }

          materialized = materializeKnowledge({
            kind: parsed.kind,
            layer: parsed.layer,
            projectId,
            knowledgeId: parsed.knowledgeId,
            content: parsed.content,
            files: filesToWrite,
            home,
            smileworkHome,
            projectPath: artifactProjectPath,
            ...(parsed.kind === "memory" ? { memory: memoryMetadata(entry) } : {}),
            mode: createdEntry ? "create" : "update",
            pruneStaleFiles: !createdEntry && filesProvided,
            preflightTargets: true,
          });

          return {
            entry,
            version: requireKnowledgeVersion(db, entry.id, versionNumber),
            artifactPath: materialized.artifactPath,
            files: materialized.files,
            warnings: check.warnings,
            idempotentReplay: false,
          };
        },
      );

      const data: WriteOutcome = { ...outcome.value, idempotentReplay: outcome.replay };
      return ok(
        outcome.replay
          ? `知識項目 ${data.entry.knowledgeId} 已存在，回傳原本的寫入結果。`
          : `已寫入${parsed.kind === "skill" ? "技能" : "記憶"} ${data.entry.knowledgeId}（${parsed.layer}，v${data.version.version}）。`,
        data,
      );
    } catch (error) {
      if (materialized) discardMaterialized(materialized);
      throw error;
    }
  },
});
