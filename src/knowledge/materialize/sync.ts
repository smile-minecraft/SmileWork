import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KnowledgeEntry, KnowledgeKind } from "../../domain/knowledge.ts";
import {
  materializeKnowledge,
  type MaterializeResult,
  type MemoryMetadata,
} from "./artifacts.ts";
import { skillArtifactPath } from "./paths.ts";

/** 記憶與技能有宿主載入的落地檔；文件只存在版本快照。 */
export function knowledgeLandingSupported(kind: KnowledgeKind): boolean {
  return kind === "memory" || kind === "skill";
}

export interface ProjectSkillArtifactSearchInput {
  home: string;
  knowledgeId: string;
  /** 目前解析到的 worktree；優先更新這裡的 artifact。 */
  currentPath: string;
  /** 同一個專案的其他 worktree，包含主 checkout。 */
  otherPaths: readonly string[];
}

export type ProjectSkillArtifactResolution =
  | { status: "found"; projectPath: string }
  | { status: "rebuild"; projectPath: string }
  | { status: "ambiguous"; candidates: string[]; matches: string[] }
  | { status: "missing"; candidates: string[] };

function uniqueExistingDirectories(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = resolve(path);
    if (seen.has(normalized) || !existsSync(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * 找出專案技能實際落地的 worktree。目前 worktree 優先，避免同一個技能同時
 * 存在於多個 checkout 時改錯位置；只有其他 worktree 唯一命中時才跨過去更新。
 * 完全找不到且只有一個 worktree 時允許在目前位置重建，超過一個則回 missing。
 */
export function resolveProjectSkillArtifact(
  input: ProjectSkillArtifactSearchInput,
): ProjectSkillArtifactResolution {
  const currentPath = resolve(input.currentPath);
  const hasArtifact = (projectPath: string): boolean =>
    existsSync(skillArtifactPath(input.home, projectPath, "project", input.knowledgeId));

  if (hasArtifact(currentPath)) {
    return { status: "found", projectPath: currentPath };
  }

  const others = uniqueExistingDirectories(input.otherPaths).filter(
    (path) => path !== currentPath,
  );
  const matches = others.filter(hasArtifact);
  if (matches.length === 1) return { status: "found", projectPath: matches[0]! };
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: [currentPath, ...others],
      matches,
    };
  }
  if (others.length === 0) {
    return { status: "rebuild", projectPath: currentPath };
  }
  return { status: "missing", candidates: [currentPath, ...others] };
}

export interface SyncKnowledgeLandingInput {
  entry: Pick<
    KnowledgeEntry,
    | "kind"
    | "layer"
    | "projectId"
    | "knowledgeId"
    | "title"
    | "description"
    | "type"
    | "pinned"
    | "source"
    | "createdAt"
    | "updatedAt"
  >;
  content: string;
  home: string;
  smileworkHome: string;
  projectPath: string | null;
}

function memoryMetadata(entry: SyncKnowledgeLandingInput["entry"]): MemoryMetadata {
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

/**
 * 用指定版本的內容覆寫既有落地檔。附件不在版本快照內，所以只更新主要檔案，
 * 不刪除或改寫其他附件。檔案不存在時會建立，供還原後重建使用。
 */
export function syncKnowledgeLanding(input: SyncKnowledgeLandingInput): MaterializeResult {
  return materializeKnowledge({
    kind: input.entry.kind,
    layer: input.entry.layer,
    projectId: input.entry.projectId,
    knowledgeId: input.entry.knowledgeId,
    content: input.content,
    files: [],
    home: input.home,
    smileworkHome: input.smileworkHome,
    projectPath: input.projectPath,
    ...(input.entry.kind === "memory" ? { memory: memoryMetadata(input.entry) } : {}),
    mode: "update",
  });
}
