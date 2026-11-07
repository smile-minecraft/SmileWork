/** 證據種類；命令與測試要有 command，連結要有 url，產物要有 path。 */
export const EVIDENCE_KINDS = ["command", "test", "review", "link", "note", "artifact"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  evidenceId: string;
  projectId: string;
  workId: string;
  kind: EvidenceKind;
  actor: string;
  actorModel: string | null;
  summary: string;
  command: string | null;
  output: string | null;
  outputPath: string | null;
  url: string | null;
  path: string | null;
  sha256: string | null;
  exitCode: number | null;
  durationMs: number | null;
  serverIssued: boolean;
  details: Record<string, unknown> | null;
  createdAt: string;
}
