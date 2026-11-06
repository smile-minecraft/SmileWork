/** `smilework-export` v1 的輸出入型別。 */

export type Layer = "project" | "global";

export type SourceRoot = "raw/project" | "raw/global";

export type WorkStatus = "open" | "in_progress" | "blocked" | "review" | "done" | "cancelled";

export type Resolution = "completed" | "failed" | "abandoned";

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
  kind: "task" | "plan";
  title: string;
  status: WorkStatus;
  resolution?: Resolution;
  owner: string;
  priority: string;
  planId?: string;
  dependsOn?: string[];
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

export interface KnowledgeVersion {
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

export interface Manifest {
  format: "smilework-export";
  formatVersion: 1;
  createdAt: string;
  producer: {
    name: "smilework";
    version: string;
  };
  source: {
    kind: "ultrawork-v3";
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

export interface KnowledgeOutput {
  record: KnowledgeRecord;
  body: string;
}

export interface RawOutput {
  layer: Layer;
  /** 相對於該層來源根目錄的原始路徑。 */
  sourcePath: string;
  /** 相對於該層來源根目錄的安全路徑，也是 raw/ 下的位置。 */
  safePath: string;
  absolutePath: string;
  sha256: string;
}

export interface PackageBuild {
  manifest: Manifest;
  work: WorkRecord[];
  events: EventRecord[];
  evidence: EvidenceRecord[];
  signals: SignalRecord[];
  knowledge: KnowledgeOutput[];
  mapping: MappingRecord[];
  raw: RawOutput[];
}
