import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { KnowledgeEntry } from "../../domain/knowledge.ts";
import {
  createKnowledgeEntry,
  findKnowledgeEntry,
  readKnowledgeEntry,
  recordKnowledgeUsage,
  requireKnowledgeEntry,
  requireKnowledgeVersion,
  setKnowledgeEntryStatus,
} from "../../knowledge/store.ts";
import { assertKnowledgeEntryVersion } from "../../knowledge/versions.ts";
import {
  discardMaterialized,
  invalidKnowledgeInput,
  KNOWLEDGE_TOOL_ERROR_CODES,
  knowledgeStoreOptions,
  materializeKnowledge,
  memoryFilesRoot,
  memoryTopicPath,
  parseKnowledgeInput,
  parseSkillFrontmatter,
  requireKnowledgeProject,
  requireProjectSkillLocation,
  resolveUserHome,
  retireKnowledgeArtifact,
  runKnowledgeWriteChecks,
  skillArtifactPath,
  smileworkHomeForDatabase,
  throwIfChecksFailed,
  type KnowledgeAuxFile,
  type MaterializeResult,
} from "../../knowledge/materialize/index.ts";
import { CHECK_CODES } from "../../knowledge/checks/index.ts";
import { withImmediateTransaction } from "../../db/transaction.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import type { ToolContext } from "../../mcp/types.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { ok } from "../../shared/result.ts";

const inputSchema = z.object({
  knowledgeId: z.string().trim().min(1).max(128),
  projectPath: z.string().min(1).optional(),
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().max(2000).optional(),
});

function promotedFromTag(projectId: string, knowledgeId: string): string {
  return `promoted-from:project:${projectId}/${knowledgeId}`;
}

function promotedToTag(knowledgeId: string): string {
  return `promoted-to:global:${knowledgeId}`;
}

function withTag(tags: readonly string[], tag: string): string[] {
  return [...new Set([...tags, tag])].sort();
}

function readAuxiliaryFiles(root: string, skipRootFile: string | null): KnowledgeAuxFile[] {
  let info;
  try {
    info = lstatSync(root);
  } catch {
    return [];
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return [];

  const files: KnowledgeAuxFile[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (skipRootFile !== null && path === skipRootFile) continue;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) continue;
      files.push({ path, content: readFileSync(absolute, "utf8") });
    }
  };
  walk(root);
  return files;
}

function entryNotFound(knowledgeId: string, projectId: string): SmileworkError {
  return new SmileworkError(
    "KNOWLEDGE_ENTRY_NOT_FOUND",
    `找不到要升級的專案知識：${knowledgeId}`,
    "先用知識搜尋確認專案層項目存在，再重新升級。",
    { knowledgeId, layer: "project", projectId },
  );
}

function globalConflict(entry: KnowledgeEntry, knowledgeId: string): SmileworkError {
  return new SmileworkError(
    "KNOWLEDGE_ALREADY_EXISTS",
    `全域層已經有同名知識：${knowledgeId}`,
    "先讀取或退役全域項目，再重新升級；跨層同名會造成載入衝突。",
    { knowledgeId, layer: "global", entryId: entry.id, status: entry.status },
  );
}

interface ProjectSkillConflictRow {
  knowledge_id: string;
  title: string;
  project_id: string | null;
}

function otherProjectConflictError(
  row: ProjectSkillConflictRow,
  knowledgeId: string,
  sourceProjectId: string,
): SmileworkError {
  return new SmileworkError(
    KNOWLEDGE_TOOL_ERROR_CODES.layerConflict,
    `專案 ${row.project_id} 已有同名技能「${row.knowledge_id}」，不能升級成全域版本。`,
    "先退役其他專案的同名技能，或改用不同的知識名稱；跨層同名會造成載入衝突。",
    {
      knowledgeId,
      projectId: sourceProjectId,
      conflictingProjectId: row.project_id,
      conflictingKnowledgeId: row.knowledge_id,
    },
  );
}

/** 升級到全域前，其他專案不能有 active 的同名技能；來源專案本身要排除。 */
function findOtherProjectSkillConflict(
  db: Database,
  sourceProjectId: string,
  knowledgeId: string,
): ProjectSkillConflictRow | null {
  return (
    db
      .query<ProjectSkillConflictRow, [string, string, string]>(
        `SELECT knowledge_id, title, project_id
         FROM knowledge_entries
         WHERE status = 'active'
           AND kind = 'skill'
           AND layer = 'project'
           AND COALESCE(project_id, '') <> ?
           AND (knowledge_id = ? OR title = ?)
         LIMIT 1`,
      )
      .get(sourceProjectId, knowledgeId, knowledgeId) ?? null
  );
}

export const tool = defineTool({
  name: "knowledge_promote",
  title: "升級知識",
  description:
    "把專案層知識升級成全域版本：先確認全域沒有同名項目，建立全域版本與實體檔案，再把原專案項目改成指向全域的退役紀錄。v1 限制：技能附檔不進版本快照，升級時會從實際 artifact 所在的 worktree 複製。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    const db = context.db();
    const smileworkHome = smileworkHomeForDatabase(db);
    const home = resolveUserHome(smileworkHome);
    const project = requireKnowledgeProject(context, parsed.projectPath);
    const projectId = project.projectId;
    const projectPath = project.worktreePath;
    const storeOptions = knowledgeStoreOptions(smileworkHome);

    const projectEntry = findKnowledgeEntry(db, parsed.knowledgeId, "project", projectId);
    if (!projectEntry) throw entryNotFound(parsed.knowledgeId, projectId);

    const fromTag = promotedFromTag(projectId, parsed.knowledgeId);
    const toTag = promotedToTag(parsed.knowledgeId);
    const globalEntry = findKnowledgeEntry(db, parsed.knowledgeId, "global", null);

    if (globalEntry?.status === "retired") {
      throw new SmileworkError(
        KNOWLEDGE_TOOL_ERROR_CODES.globalRetired,
        `全域知識 ${parsed.knowledgeId} 已經退役，不能再當成升級完成的目標。`,
        "先還原或重新建立全域知識，再重新升級；不要把專案項目指向已退役的全域版本。",
        {
          knowledgeId: parsed.knowledgeId,
          globalEntryId: globalEntry.id,
          status: globalEntry.status,
        },
      );
    }

    if (globalEntry?.tags.includes(fromTag)) {
      return finishPromotedProject(db, {
        globalEntry,
        projectEntry,
        projectPath,
        home,
        smileworkHome,
        parsed,
        context,
        toTag,
      });
    }
    if (globalEntry) throw globalConflict(globalEntry, parsed.knowledgeId);
    if (projectEntry.status !== "active") {
      throw new SmileworkError(
        "KNOWLEDGE_NOT_ACTIVE",
        `專案知識 ${parsed.knowledgeId} 目前是 ${projectEntry.status}，不能升級。`,
        "只有 active 的專案知識可以升級；先確認歷史或建立新的知識項目。",
        { knowledgeId: parsed.knowledgeId, status: projectEntry.status },
      );
    }
    const otherProjectConflict =
      projectEntry.kind === "skill"
        ? findOtherProjectSkillConflict(db, projectId, parsed.knowledgeId)
        : null;
    if (otherProjectConflict) {
      throw otherProjectConflictError(
        otherProjectConflict,
        parsed.knowledgeId,
        projectId,
      );
    }

    assertKnowledgeEntryVersion(projectEntry, parsed.expectedVersion);
    let artifactProjectPath = projectPath;
    if (projectEntry.kind === "skill") {
      const location = requireProjectSkillLocation(
        db,
        projectId,
        parsed.knowledgeId,
        projectPath,
      );
      if (location) artifactProjectPath = location.worktreePath;
    }

    const current = readKnowledgeEntry(db, projectEntry.id, {
      ...storeOptions,
      recordUsage: false,
    });
    const sourceAux =
      projectEntry.kind === "skill"
        ? readAuxiliaryFiles(
            skillArtifactPath(home, artifactProjectPath, "project", parsed.knowledgeId),
            "SKILL.md",
          )
        : readAuxiliaryFiles(
            memoryFilesRoot(smileworkHome, "project", projectId, parsed.knowledgeId),
            null,
          );
    const frontmatter =
      projectEntry.kind === "skill" ? parseSkillFrontmatter(current.content) : null;
    const description =
      projectEntry.description.trim().length > 0
        ? projectEntry.description
        : (frontmatter?.description ?? "");

    const check = runKnowledgeWriteChecks(
      {
        kind: projectEntry.kind,
        layer: "global",
        projectId,
        knowledgeId: parsed.knowledgeId,
        title: projectEntry.title,
        description,
        source: projectEntry.source,
        tags: projectEntry.tags,
        reason: parsed.reason,
        sourceSignalIds: current.version.sourceSignalIds,
        content: current.content,
        files: sourceAux,
      },
      db,
    );
    // 內建跨層檢查會把來源專案自己算成衝突；其他專案的衝突已在上面先擋掉。
    const otherErrors = check.errors.filter(
      (issue) => issue.code !== CHECK_CODES.skillNameConflict,
    );
    throwIfChecksFailed({
      ...check,
      ok: otherErrors.length === 0,
      errors: otherErrors,
    });

    let materialized: MaterializeResult | null = null;
    let outcome: {
      globalEntry: KnowledgeEntry;
      version: ReturnType<typeof requireKnowledgeVersion>;
      projectEntry: KnowledgeEntry;
      artifactPath: string;
      files: MaterializeResult["files"];
    };
    try {
      outcome = withImmediateTransaction(db, () => {
        const racedConflict =
          projectEntry.kind === "skill"
            ? findOtherProjectSkillConflict(db, projectId, parsed.knowledgeId)
            : null;
        if (racedConflict) {
          throw otherProjectConflictError(
            racedConflict,
            parsed.knowledgeId,
            projectId,
          );
        }

        const createdGlobal = createKnowledgeEntry(
          db,
          {
            knowledgeId: parsed.knowledgeId,
            layer: "global",
            projectId: null,
            kind: projectEntry.kind,
            type: projectEntry.type,
            title: projectEntry.title,
            description,
            pinned: projectEntry.pinned,
            source: projectEntry.source,
            tags: withTag(projectEntry.tags, fromTag),
            content: current.content,
            actor: context.actor.name,
            actorModel: context.actor.model,
            reason: parsed.reason ?? `升級自專案 ${projectId}/${parsed.knowledgeId}`,
            sourceSignalIds: current.version.sourceSignalIds,
            workId: projectEntry.workId,
          },
          storeOptions,
        );

        const artifact = materializeKnowledge({
          kind: createdGlobal.kind,
          layer: "global",
          projectId: null,
          knowledgeId: createdGlobal.knowledgeId,
          content: current.content,
          files: sourceAux,
          home,
          smileworkHome,
          projectPath: null,
          ...(createdGlobal.kind === "memory"
            ? {
                memory: {
                  title: createdGlobal.title,
                  description: createdGlobal.description,
                  type: createdGlobal.type,
                  pinned: createdGlobal.pinned,
                  source: createdGlobal.source,
                  createdAt: createdGlobal.createdAt,
                  updatedAt: createdGlobal.updatedAt,
                  verifiedAt: createdGlobal.updatedAt,
                },
              }
            : {}),
          mode: "create",
        });
        materialized = artifact;

        const retired = setRetiredWithPointer(
          db,
          projectEntry,
          toTag,
          context.actor.name,
          context.actor.model,
          projectEntry.version,
        );
        recordKnowledgeUsage(db, {
          knowledgeId: retired.knowledgeId,
          projectId: retired.projectId,
          layer: retired.layer,
          version: retired.currentVersion,
          action: "promote",
          actor: context.actor.name,
          actorModel: context.actor.model,
          details: {
            globalEntryId: createdGlobal.id,
            ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
          },
        });

        return {
          globalEntry: createdGlobal,
          version: requireKnowledgeVersion(db, createdGlobal.id, createdGlobal.currentVersion),
          projectEntry: retired,
          artifactPath: artifact.artifactPath,
          files: artifact.files,
        };
      });
    } catch (error) {
      if (materialized) discardMaterialized(materialized);
      throw error;
    }

    const archived = retireKnowledgeArtifact({
      entry: outcome.projectEntry,
      home,
      smileworkHome,
      projectPath: outcome.projectEntry.kind === "skill" ? artifactProjectPath : projectPath,
    });

    return ok(`已把 ${parsed.knowledgeId} 升級成全域知識。`, {
      global: {
        entry: outcome.globalEntry,
        version: outcome.version,
        artifactPath:
          outcome.globalEntry.kind === "skill"
            ? skillArtifactPath(home, null, "global", outcome.globalEntry.knowledgeId)
            : memoryTopicPath(
                smileworkHome,
                "global",
                null,
                outcome.globalEntry.knowledgeId,
              ),
        files: outcome.files,
      },
      project: outcome.projectEntry,
      ...archived,
      warnings: check.warnings,
      idempotentReplay: false,
    });
  },
});

interface FinishPromotedInput {
  globalEntry: KnowledgeEntry;
  projectEntry: KnowledgeEntry;
  projectPath: string;
  home: string;
  smileworkHome: string;
  parsed: z.infer<typeof inputSchema>;
  context: ToolContext;
  toTag: string;
}

/** 上一次升級已完成全域建立，但專案項目還沒退役或封存時，從中斷點補完。 */
function finishPromotedProject(db: Database, input: FinishPromotedInput) {
  let projectEntry = input.projectEntry;
  let artifactProjectPath = input.projectPath;
  if (projectEntry.kind === "skill") {
    if (projectEntry.projectId === null) {
      throw invalidKnowledgeInput(
        "專案技能缺少 projectId，無法定位實體檔案。",
        "回報這個問題並確認知識項目的 project_id。",
        { field: "projectId", knowledgeId: projectEntry.knowledgeId },
      );
    }
    const location = requireProjectSkillLocation(
      db,
      projectEntry.projectId,
      projectEntry.knowledgeId,
      input.projectPath,
      { allowMissing: projectEntry.status === "retired" },
    );
    if (location) artifactProjectPath = location.worktreePath;
  }

  if (projectEntry.status !== "retired") {
    assertKnowledgeEntryVersion(projectEntry, input.parsed.expectedVersion);
    projectEntry = withImmediateTransaction(db, () => {
      const retired = setRetiredWithPointer(
        db,
        projectEntry,
        input.toTag,
        input.context.actor.name,
        input.context.actor.model,
        projectEntry.version,
      );
      recordKnowledgeUsage(db, {
        knowledgeId: retired.knowledgeId,
        projectId: retired.projectId,
        layer: retired.layer,
        version: retired.currentVersion,
        action: "promote",
        actor: input.context.actor.name,
        actorModel: input.context.actor.model,
        details: {
          globalEntryId: input.globalEntry.id,
          resumed: true,
          ...(input.parsed.reason === undefined ? {} : { reason: input.parsed.reason }),
        },
      });
      return retired;
    });
  } else if (!projectEntry.tags.includes(input.toTag)) {
    db.query("UPDATE knowledge_entries SET tags = ? WHERE id = ?").run(
      JSON.stringify(withTag(projectEntry.tags, input.toTag)),
      projectEntry.id,
    );
    projectEntry = requireKnowledgeEntry(db, projectEntry.id);
  }

  const archived = retireKnowledgeArtifact({
    entry: projectEntry,
    home: input.home,
    smileworkHome: input.smileworkHome,
    projectPath: projectEntry.kind === "skill" ? artifactProjectPath : input.projectPath,
  });

  return ok(`知識項目 ${input.globalEntry.knowledgeId} 已經是全域版本，補完專案端的退役紀錄。`, {
    global: {
      entry: input.globalEntry,
      version: requireKnowledgeVersion(db, input.globalEntry.id, input.globalEntry.currentVersion),
      artifactPath:
        input.globalEntry.kind === "skill"
          ? skillArtifactPath(input.home, null, "global", input.globalEntry.knowledgeId)
          : memoryTopicPath(input.smileworkHome, "global", null, input.globalEntry.knowledgeId),
      files: [],
    },
    project: projectEntry,
    ...archived,
    warnings: [],
    idempotentReplay: true,
  });
}

function setRetiredWithPointer(
  db: Database,
  entry: KnowledgeEntry,
  tag: string,
  actor: string,
  actorModel: string | null,
  expectedVersion: number | undefined,
): KnowledgeEntry {
  const retired = setKnowledgeEntryStatus(db, entry.id, {
    status: "retired",
    actor,
    actorModel,
    expectedVersion,
  });
  db.query("UPDATE knowledge_entries SET tags = ? WHERE id = ?").run(
    JSON.stringify(withTag(retired.tags, tag)),
    retired.id,
  );
  return requireKnowledgeEntry(db, retired.id);
}
