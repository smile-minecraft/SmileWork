/** 代理隨手記下的訊號；不是工作狀態，也不改變工作狀態。 */
export const SIGNAL_KINDS = [
  "correction",
  "failure",
  "fix",
  "review-reject",
  "lesson",
  "other",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_STATUSES = ["new", "consumed", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const SIGNAL_SCOPES = ["project", "global"] as const;
export type SignalScope = (typeof SIGNAL_SCOPES)[number];

export interface Signal {
  signalId: string;
  projectId: string | null;
  scope: SignalScope;
  kind: SignalKind;
  content: string;
  status: SignalStatus;
  workId: string | null;
  refs: string[];
  resultRefs: string[];
  reason: string | null;
  actor: string;
  actorModel: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}
