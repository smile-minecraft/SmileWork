/**
 * 工作狀態與轉移規則。值是匯出格式 v1 的六個狀態，避免資料庫與匯出格式各一套。
 */

export const WORK_STATUSES = ["open", "in_progress", "blocked", "review", "done", "cancelled"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_RESOLUTIONS = ["completed", "failed", "abandoned"] as const;
export type WorkResolution = (typeof WORK_RESOLUTIONS)[number];

export const WORK_KINDS = ["task", "plan"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const WORK_PRIORITIES = ["low", "normal", "high"] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

/** done 與 cancelled 只能由結案流程進入，不在一般更新的轉移表裡。 */
export const ALLOWED_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  open: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "review", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  review: ["in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransition(from: WorkStatus, to: WorkStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type ReviewVerdict = "approve" | "concerns" | "reject";

export interface WorkReview {
  verdict: ReviewVerdict;
  reviewer: string;
  note?: string;
  reworkedAfterReview?: boolean;
  reviewedAt?: string;
  reviewedVersion?: number;
}

export interface AcceptanceResultItem {
  criterion: string;
  met: boolean;
  evidenceIds: string[];
}

export interface AcceptanceResults {
  recordedBy: string;
  items: AcceptanceResultItem[];
  recordedAt?: string;
}

export interface WorkItem {
  workId: string;
  projectId: string;
  kind: WorkKind;
  title: string;
  status: WorkStatus;
  resolution: WorkResolution | null;
  owner: string;
  priority: string;
  planId: string | null;
  objective: string | null;
  nonGoals: string[];
  contextRefs: string[];
  scopePaths: string[];
  acceptance: string[];
  risk: RiskLevel | null;
  review: WorkReview | null;
  acceptanceResults: AcceptanceResults | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}
