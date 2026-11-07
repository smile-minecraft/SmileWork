/**
 * 知識項目同時保留 kind（記憶、技能、文件）與 type（決策、參考、教訓等），
 * 對應工具的 kind 篩選與匯出格式的 type 欄位。
 */
export const KNOWLEDGE_KINDS = ["memory", "skill", "document"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_TYPES = [
  "decision",
  "reference",
  "lesson",
  "pitfall",
  "preference",
  "document",
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const KNOWLEDGE_LAYERS = ["project", "global"] as const;
export type KnowledgeLayer = (typeof KNOWLEDGE_LAYERS)[number];

export const KNOWLEDGE_STATUSES = ["active", "retired"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export interface KnowledgeEntry {
  id: number;
  knowledgeId: string;
  layer: KnowledgeLayer;
  projectId: string | null;
  kind: KnowledgeKind;
  type: KnowledgeType;
  title: string;
  description: string;
  pinned: boolean;
  source: string;
  tags: string[];
  status: KnowledgeStatus;
  currentVersion: number;
  version: number;
  workId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface KnowledgeVersion {
  entryId: number;
  version: number;
  sha256: string;
  bytes: number;
  snapshotPath: string;
  actor: string;
  actorModel: string | null;
  reason: string | null;
  sourceSignalIds: string[];
  workId: string | null;
  createdAt: string;
}
