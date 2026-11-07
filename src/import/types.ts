/** `smilework-export` v1 的完整型別；import 與目前資料庫匯出共用同一份模型。 */

export const WORK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled",
] as const;

export const WORK_RESOLUTIONS = ["completed", "failed", "abandoned"] as const;

export const WORK_KINDS = ["task", "plan"] as const;

export const RISK_LEVELS = ["low", "medium", "high"] as const;

export const EVENT_KINDS = [
  "created",
  "status_changed",
  "reviewed",
  "verified",
  "evidence_added",
  "signal_recorded",
  "knowledge_written",
  "note",
] as const;

export const EVIDENCE_KINDS = ["command", "test", "review", "link", "note", "artifact"] as const;

export const SIGNAL_SEVERITIES = ["info", "warning", "error"] as const;

export const SIGNAL_STATUSES = ["open", "triaged", "accepted", "dismissed"] as const;

/** signal 的內部相容資料放在 details 的這個鍵底下，不新增 v1 頂層欄位。 */
export const SIGNAL_DETAILS_KEY = "smileworkExport";

export const KNOWLEDGE_TYPES = [
  "decision",
  "reference",
  "lesson",
  "pitfall",
  "preference",
  "document",
] as const;

export const LAYERS = ["project", "global"] as const;

export const MAPPING_ENTITIES = [
  "work",
  "event",
  "evidence",
  "signal",
  "knowledge",
  "raw",
] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];
export type WorkResolution = (typeof WORK_RESOLUTIONS)[number];
export type WorkKind = (typeof WORK_KINDS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];
export type Layer = (typeof LAYERS)[number];
export type SourceRoot = "raw/project" | "raw/global";
export type MappingEntity = (typeof MAPPING_ENTITIES)[number];

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
  resolution?: WorkResolution;
  owner: string;
  priority: string;
  planId?: string;
  dependsOn?: string[];
  objective?: string;
  nonGoals?: string[];
  contextRefs?: string[];
  scopePaths?: string[];
  acceptance?: string[];
  risk?: RiskLevel;
  review?: WorkReview;
  acceptanceResults?: WorkAcceptanceResults;
}

export interface EventRecord {
  eventId: string;
  sequence: number;
  kind: EventKind;
  actor: string;
  workId?: string;
  fromStatus?: WorkStatus;
  toStatus?: WorkStatus;
  resolution?: WorkResolution;
  summary?: string;
  details?: Record<string, unknown>;
}

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
  severity: SignalSeverity;
  code: string;
  message: string;
  workId?: string;
  details?: Record<string, unknown>;
}

/**
 * 匯入時額外帶回的資料庫欄位。這些不是 v1 頂層欄位，
 * 只從 details 的內部鍵讀出，套件輸出時仍留在 details。
 */
export interface ParsedSignal extends SignalRecord {
  scope?: Layer;
  status?: SignalStatus;
  refs?: string[];
  resultRefs?: string[];
  reason?: string;
}

export interface KnowledgeVersionEntry {
  version: number;
  path: string;
  sha256: string;
  bytes: number;
}

export interface KnowledgeRecord {
  knowledgeId: string;
  type: KnowledgeType;
  layer: Layer;
  title: string;
  description: string;
  pinned: boolean;
  source: string;
  versions: KnowledgeVersionEntry[];
  currentVersion: number;
  workId?: string;
  tags?: string[];
}

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

export interface Manifest {
  format: "smilework-export";
  formatVersion: 1;
  createdAt: string;
  producer: { name: "smilework"; version: string };
  source: {
    kind: "ultrawork-v3" | "smilework-db";
    projectId: string;
    projectPath?: string;
    registryVersion?: string;
    layers: Layer[];
  };
  layout: {
    manifest: { path: "manifest.json" };
    work: { path: "work.jsonl"; records: number };
    events: { path: "events.jsonl"; records: number };
    evidence: { path: "evidence.jsonl"; records: number };
    signals: { path: "signals.jsonl"; records: number };
    knowledge: { path: "knowledge/"; entries: number; files: number };
    mapping: { path: "mapping.jsonl"; records: number };
    raw: { path: "raw/"; files: number; projectFiles: number; globalFiles: number };
  };
  warnings: string[];
}

export interface KnowledgeVersionBody {
  version: number;
  body: string;
}

export interface KnowledgeInput {
  record: KnowledgeRecord;
  versions: KnowledgeVersionBody[];
}

export interface RawFile {
  layer: Layer;
  /** 相對於 raw/<layer>/ 的路徑。 */
  path: string;
}

export interface PackageContents {
  root: string;
  manifest: Manifest;
  work: WorkRecord[];
  events: EventRecord[];
  evidence: EvidenceRecord[];
  signals: ParsedSignal[];
  knowledge: KnowledgeInput[];
  mapping: MappingRecord[];
  raw: RawFile[];
}

export interface ImportCounts {
  work: number;
  events: number;
  evidence: number;
  signals: number;
  knowledge: number;
  knowledgeVersions: number;
  mapping: number;
  raw: number;
}

export interface ImportInserted extends ImportCounts {}

export interface ImportResult {
  packageDir: string;
  projectId: string;
  dryRun: boolean;
  counts: ImportCounts;
  inserted: ImportInserted;
  skipped: ImportCounts;
  warnings: string[];
  dbPath?: string;
}

export interface ExportCurrentResult {
  outDir: string;
  projectId: string;
  manifest: Manifest;
  warnings: string[];
}
