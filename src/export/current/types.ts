import type {
  EvidenceRecord,
  EventRecord,
  KnowledgeInput,
  KnowledgeRecord,
  Manifest,
  MappingRecord,
  SignalRecord,
  WorkRecord,
} from "../../import/types.ts";

export interface RawOutput {
  layer: "project" | "global";
  /** 相對於 raw/<layer>/ 的路徑。 */
  path: string;
  bytes: Buffer;
}

export interface CurrentPackage {
  manifest: Manifest;
  work: WorkRecord[];
  events: EventRecord[];
  evidence: EvidenceRecord[];
  signals: SignalRecord[];
  knowledge: KnowledgeInput[];
  mapping: MappingRecord[];
  raw: RawOutput[];
}

export type { KnowledgeRecord };
