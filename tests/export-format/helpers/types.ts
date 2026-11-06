export const WORK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled",
] as const;

export const RESOLUTIONS = ["completed", "failed", "abandoned"] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];
export type Resolution = (typeof RESOLUTIONS)[number];
export type WorkKind = "task" | "plan";
export type Layer = "project" | "global";
export type SourceRoot = "raw/project" | "raw/global";

export interface Producer {
  name: "smilework";
  version: string;
}

export interface Source {
  kind: "ultrawork-v3" | "smilework-db";
  projectId: string;
  projectPath?: string;
  registryVersion?: string;
  layers: Layer[];
}

export interface WorkReview {
  verdict: "approve" | "concerns" | "reject";
  reviewer: string;
  note?: string;
  reworkedAfterReview?: boolean;
}

export interface WorkAcceptanceResultItem {
  criterion: string;
  met: boolean;
  evidence?: string;
}

export interface WorkAcceptanceResults {
  recordedBy: string;
  items: WorkAcceptanceResultItem[];
}

export interface WorkRecord {
  workId: string;
  kind: WorkKind;
  title: string;
  status: WorkStatus;
  resolution?: Resolution;
  owner: string;
  priority: string;
  planId?: string;
  dependsOn?: string[];
  objective?: string;
  nonGoals?: string[];
  contextRefs?: string[];
  scopePaths?: string[];
  acceptance?: string[];
  risk?: "low" | "medium" | "high";
  review?: WorkReview;
  acceptanceResults?: WorkAcceptanceResults;
}

export type EventKind =
  | "created"
  | "status_changed"
  | "reviewed"
  | "verified"
  | "evidence_added"
  | "signal_recorded"
  | "knowledge_written"
  | "note";

export interface EventRecord {
  eventId: string;
  sequence: number;
  kind: EventKind;
  actor: string;
  workId?: string;
  fromStatus?: WorkStatus;
  toStatus?: WorkStatus;
  resolution?: Resolution;
  summary?: string;
  details?: Record<string, unknown>;
}

export type EvidenceKind = "command" | "test" | "review" | "link" | "note" | "artifact";

export interface EvidenceRecord {
  evidenceId: string;
  workId: string;
  kind: EvidenceKind;
  actor: string;
  summary: string;
  command?: string;
  output?: string;
  url?: string;
  path?: string;
  sha256?: string;
  details?: Record<string, unknown>;
}

export interface SignalRecord {
  signalId: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  workId?: string;
  details?: Record<string, unknown>;
}

export type KnowledgeType =
  | "decision"
  | "reference"
  | "lesson"
  | "pitfall"
  | "preference"
  | "document";

export type KnowledgeLayer = "project" | "global";

export interface KnowledgeVersion {
  version: number;
  path: string;
  sha256: string;
  bytes: number;
}

export interface KnowledgeRecord {
  knowledgeId: string;
  type: KnowledgeType;
  layer: KnowledgeLayer;
  title: string;
  description: string;
  pinned: boolean;
  source: string;
  versions: KnowledgeVersion[];
  currentVersion: number;
  workId?: string;
  tags?: string[];
}

export type MappingEntity = "work" | "event" | "evidence" | "signal" | "knowledge" | "raw";

export interface MappingRecord {
  entity: MappingEntity;
  layer: Layer;
  sourceRoot: SourceRoot;
  sourceId: string;
  sourceRecord?: string;
  targetId: string;
  sourceRef: string;
  sha256?: string;
  note?: string;
}

export interface KnowledgeVersionInput {
  version: number;
  body: string;
}

export interface KnowledgeInput {
  knowledgeId: string;
  type: KnowledgeType;
  layer: KnowledgeLayer;
  title: string;
  description: string;
  pinned: boolean;
  source: string;
  currentVersion: number;
  versions: KnowledgeVersionInput[];
  workId?: string;
  tags?: string[];
}

export interface RawFileInput {
  layer: Layer;
  path: string;
  body: string | Uint8Array;
}

export interface PackageInput {
  producer: Producer;
  source: Source;
  warnings?: string[];
  work: WorkRecord[];
  events: EventRecord[];
  evidence: EvidenceRecord[];
  signals: SignalRecord[];
  knowledge: KnowledgeInput[];
  mapping: MappingRecord[];
  raw: RawFileInput[];
}

export interface ManifestLayout {
  manifest: { path: "manifest.json" };
  work: { path: "work.jsonl"; records: number };
  events: { path: "events.jsonl"; records: number };
  evidence: { path: "evidence.jsonl"; records: number };
  signals: { path: "signals.jsonl"; records: number };
  knowledge: { path: "knowledge/"; entries: number; files: number };
  mapping: { path: "mapping.jsonl"; records: number };
  raw: { path: "raw/"; files: number; projectFiles: number; globalFiles: number };
}

export interface Manifest {
  format: "smilework-export";
  formatVersion: 1;
  createdAt: string;
  producer: Producer;
  source: Source;
  layout: ManifestLayout;
  warnings: string[];
}

export type RecordPart =
  | "work"
  | "events"
  | "evidence"
  | "signals"
  | "knowledge"
  | "mapping";

export type PackageRecord = WorkRecord | EventRecord | EvidenceRecord | SignalRecord | KnowledgeRecord | MappingRecord;
