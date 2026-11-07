import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { KnowledgeEntry, ProjectContext } from "../../domain/index.ts";
import { KNOWLEDGE_LAYERS } from "../../domain/index.ts";
import { withImmediateTransaction } from "../../db/transaction.ts";
import { resolveUserHome, smileworkHomeForDatabase } from "../../knowledge/materialize/paths.ts";
import {
  knowledgeLandingSupported,
  resolveProjectSkillArtifact,
  syncKnowledgeLanding,
} from "../../knowledge/materialize/sync.ts";
import type { MaterializeResult } from "../../knowledge/materialize/index.ts";
import {
  readKnowledgeVersion,
  requireKnowledgeVersion,
  restoreKnowledgeVersion,
} from "../../knowledge/store.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { getProject } from "../../project/registry.ts";
import { ok } from "../../shared/result.ts";
import {
  knowledgeEntryView,
  knowledgeStoreOptions,
  knowledgeVersionView,
  parseKnowledgeInput,
  requireKnowledgeEntryForTool,
  requireKnowledgeProject,
} from "./read.ts";

const inputSchema = z.object({
  knowledgeId: z.string().min(1).max(200),
  layer: z.enum(KNOWLEDGE_LAYERS).default("project"),
  projectPath: z.string().min(1).optional(),
  version: z.number().int().min(1),
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().min(1).max(1000).optional(),
});

type LandingSkipReason = "artifact-not-found" | "artifact-ambiguous";

type LandingSelection =
  | { status: "none" }
  | { status: "sync"; projectPath: string | null }
  | { status: "skipped"; reason: LandingSkipReason; candidates: string[]; matches?: string[] };

function otherWorktreePaths(db: Database, project: ProjectContext): string[] {
  const paths: string[] = [project.rootPath];
  for (const worktree of getProject(db, project.projectId)?.worktrees ?? []) {
    paths.push(worktree.worktreePath);
  }
  return paths;
}

/**
 * 技能檔案在每個 worktree 各自一份；目前 worktree 沒有時才找同專案的其他
 * worktree。找不到唯一位置就不落地，避免把內容寫進錯的 checkout。
 */
function selectLanding(
  db: Database,
  entry: KnowledgeEntry,
  project: ProjectContext | null,
  home: string,
): LandingSelection {
  if (!knowledgeLandingSupported(entry.kind)) return { status: "none" };
  if (entry.kind === "memory" || entry.layer === "global") {
    return { status: "sync", projectPath: null };
  }
  if (!project) {
    return { status: "skipped", reason: "artifact-not-found", candidates: [] };
  }

  const resolution = resolveProjectSkillArtifact({
    home,
    knowledgeId: entry.knowledgeId,
    currentPath: project.worktreePath,
    otherPaths: otherWorktreePaths(db, project),
  });
  switch (resolution.status) {
    case "found":
    case "rebuild":
      return { status: "sync", projectPath: resolution.projectPath };
    case "ambiguous":
      return {
        status: "skipped",
        reason: "artifact-ambiguous",
        candidates: resolution.candidates,
        matches: resolution.matches,
      };
    case "missing":
      return {
        status: "skipped",
        reason: "artifact-not-found",
        candidates: resolution.candidates,
      };
  }
}

function landingView(selection: LandingSelection, materialized: MaterializeResult | null) {
  if (selection.status === "sync" && materialized !== null) {
    return {
      synced: true as const,
      projectPath: selection.projectPath,
      artifactPath: materialized.artifactPath,
      createdRoot: materialized.createdRoot,
      files: materialized.files.map((file) => ({
        path: file.path,
        absolutePath: file.absolutePath,
        bytes: file.bytes,
      })),
    };
  }
  if (selection.status !== "skipped") return null;
  return {
    synced: false as const,
    reason: selection.reason,
    artifactPath: null,
    createdRoot: false,
    files: [] as Array<{ path: string; absolutePath: string; bytes: number }>,
    candidates: selection.candidates,
    ...(selection.matches === undefined ? {} : { matches: selection.matches }),
  };
}

export const tool = defineTool({
  name: "knowledge_revert",
  title: "還原知識版本",
  description:
    "把指定版本的內容建立成新的目前版本，舊版本全部保留，並同步更新記憶或技能的落地檔。專案技能會優先更新目前 worktree 的檔案，找不到時才定位其他已登記 worktree；無法唯一確定位置時只還原版本並標示 landing 未同步。新版本與來源版本的內容逐位元組相同；可用 expectedVersion 避免覆蓋別人的更新。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    const entry = requireKnowledgeEntryForTool(context, parsed);
    const project =
      entry.layer === "project" ? requireKnowledgeProject(context, parsed.projectPath) : null;
    const db = context.db();
    const storeOptions = knowledgeStoreOptions(db);
    const source = requireKnowledgeVersion(db, entry.id, parsed.version);
    const smileworkHome = smileworkHomeForDatabase(db);
    const home = resolveUserHome(smileworkHome);
    const selection = selectLanding(db, entry, project, home);

    const outcome = withImmediateTransaction(db, () => {
      const restored = restoreKnowledgeVersion(
        db,
        {
          entryId: entry.id,
          version: source.version,
          actor: context.actor.name,
          actorModel: context.actor.model,
          reason: parsed.reason,
          expectedVersion: parsed.expectedVersion,
        },
        storeOptions,
      );
      const content = readKnowledgeVersion(db, restored.entry.id, restored.version.version, {
        ...storeOptions,
        recordUsage: false,
      }).content;
      const landing =
        selection.status === "sync"
          ? syncKnowledgeLanding({
              entry: restored.entry,
              content,
              home,
              smileworkHome,
              projectPath: selection.projectPath,
            })
          : null;
      return { restored, landing };
    });

    const landing = landingView(selection, outcome.landing);
    const summary = `已將知識 ${entry.knowledgeId} 還原至版本 ${source.version}，建立版本 ${outcome.restored.version.version}。`;
    const landingNote =
      landing === null || landing.synced
        ? null
        : landing.reason === "artifact-ambiguous"
          ? "落地檔存在於多個 worktree，無法唯一確定位置，只還原版本。"
          : "找不到既有落地檔，只還原版本。";

    return ok(landingNote === null ? summary : `${summary}${landingNote}`, {
      entry: knowledgeEntryView(outcome.restored.entry),
      restoredFrom: {
        version: source.version,
        sha256: source.sha256,
        bytes: source.bytes,
      },
      version: knowledgeVersionView(outcome.restored.version),
      byteIdentical:
        outcome.restored.version.sha256 === source.sha256 &&
        outcome.restored.version.bytes === source.bytes,
      landing,
    });
  },
});
