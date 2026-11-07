import { z } from "zod";
import { KNOWLEDGE_LAYERS } from "../../domain/knowledge.ts";
import { withImmediateTransaction } from "../../db/transaction.ts";
import {
  findKnowledgeEntry,
  recordKnowledgeUsage,
  requireKnowledgeEntry,
  setKnowledgeEntryStatus,
} from "../../knowledge/store.ts";
import {
  parseKnowledgeInput,
  requireKnowledgeProject,
  requireProjectSkillLocation,
  retireKnowledgeArtifact,
  resolveUserHome,
  smileworkHomeForDatabase,
} from "../../knowledge/materialize/index.ts";
import { defineTool } from "../../mcp/define-tool.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { ok } from "../../shared/result.ts";

const inputSchema = z.object({
  knowledgeId: z.string().trim().min(1).max(128),
  layer: z.enum(KNOWLEDGE_LAYERS).default("project"),
  projectPath: z.string().min(1).optional(),
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().max(2000).optional(),
});

export const tool = defineTool({
  name: "knowledge_retire",
  title: "退役知識",
  description:
    "把知識標成退役，保留所有歷史版本，並把技能資料夾或記憶檔移到封存區。重複呼叫不會新增版本。",
  domain: "knowledge",
  inputSchema,
  handler(input, context) {
    const parsed = parseKnowledgeInput(inputSchema, input);
    const db = context.db();
    const smileworkHome = smileworkHomeForDatabase(db);
    const home = resolveUserHome(smileworkHome);
    const project =
      parsed.layer === "project"
        ? requireKnowledgeProject(context, parsed.projectPath)
        : null;
    const projectId = project?.projectId ?? null;
    const projectPath = project?.worktreePath ?? null;

    const entry = findKnowledgeEntry(db, parsed.knowledgeId, parsed.layer, projectId);
    if (!entry) {
      throw new SmileworkError(
        "KNOWLEDGE_ENTRY_NOT_FOUND",
        `找不到知識項目：${parsed.knowledgeId}（${parsed.layer}）`,
        "用知識搜尋確認 knowledgeId 與 layer，再重新退役。",
        { knowledgeId: parsed.knowledgeId, layer: parsed.layer, projectId },
      );
    }

    let alreadyRetired = entry.status === "retired";
    let artifactProjectPath = projectPath;
    if (entry.kind === "skill" && entry.layer === "project") {
      if (projectId === null) {
        throw new SmileworkError(
          "KNOWLEDGE_INVALID_TARGET",
          "專案技能缺少 projectId，無法定位實體檔案。",
          "回報這個問題並確認知識項目的 project_id。",
          { knowledgeId: entry.knowledgeId },
        );
      }
      const location = requireProjectSkillLocation(
        db,
        projectId,
        entry.knowledgeId,
        projectPath ?? undefined,
        { allowMissing: alreadyRetired },
      );
      if (location) artifactProjectPath = location.worktreePath;
    }

    const retired = alreadyRetired
      ? entry
      : withImmediateTransaction(db, () => {
          const current = requireKnowledgeEntry(db, entry.id);
          if (current.status === "retired") {
            alreadyRetired = true;
            return current;
          }
          const updated = setKnowledgeEntryStatus(db, entry.id, {
            status: "retired",
            actor: context.actor.name,
            actorModel: context.actor.model,
            expectedVersion: parsed.expectedVersion,
          });
          recordKnowledgeUsage(db, {
            knowledgeId: updated.knowledgeId,
            projectId: updated.projectId,
            layer: updated.layer,
            version: updated.currentVersion,
            action: "retire",
            actor: context.actor.name,
            actorModel: context.actor.model,
            details: parsed.reason === undefined ? null : { reason: parsed.reason },
          });
          return updated;
        });

    const artifacts = retireKnowledgeArtifact({
      entry: retired,
      home,
      smileworkHome,
      projectPath: retired.kind === "skill" ? artifactProjectPath : projectPath,
    });

    return ok(
      alreadyRetired
        ? `知識項目 ${retired.knowledgeId} 已經是退役狀態。`
        : `已退役知識項目 ${retired.knowledgeId}，歷史版本保留在 ${retired.currentVersion} 版。`,
      {
        entry: retired,
        alreadyRetired,
        ...artifacts,
      },
    );
  },
});
