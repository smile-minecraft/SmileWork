import type {
  AcceptanceResultItem,
  ReviewVerdict,
  WorkItem,
  WorkStatus,
} from "../domain/work.ts";

/** 結案與審查對外回報的錯誤碼；字串值直接進工具失敗外框。 */
export const WORK_ERROR_CODES = {
  workNotFound: "WORK_NOT_FOUND",
  versionConflict: "VERSION_CONFLICT",
  acceptanceIncomplete: "ACCEPTANCE_INCOMPLETE",
  evidenceRequired: "EVIDENCE_REQUIRED",
  reviewRequired: "REVIEW_REQUIRED",
  reviewStale: "REVIEW_STALE",
  reviewerIsOwner: "REVIEWER_IS_OWNER",
  serverEvidenceRequired: "SERVER_EVIDENCE_REQUIRED",
  serverEvidenceFailed: "SERVER_EVIDENCE_FAILED",
  dependencyNotDone: "DEPENDENCY_NOT_DONE",
  invalidTransition: "INVALID_TRANSITION",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
} as const;

export type WorkErrorCode = (typeof WORK_ERROR_CODES)[keyof typeof WORK_ERROR_CODES];

export interface GateIssue {
  code: WorkErrorCode;
  message: string;
  nextAction: string;
  data: Record<string, unknown>;
}

export interface EvidenceReference {
  evidenceId: string;
  serverIssued: boolean;
  /** 伺服器驗證的結束碼；null 表示沒有記錄（舊資料）或逾時。 */
  exitCode: number | null;
  /** verify_run 逾時時為 true；舊資料或沒有 details 時為 false。 */
  timedOut: boolean;
}

export interface DependencyReference {
  workId: string;
  title: string;
  status: WorkStatus;
}

export interface CompletionGateInput {
  work: WorkItem;
  acceptance: readonly AcceptanceResultItem[];
  evidence: readonly EvidenceReference[];
  dependencies: readonly DependencyReference[];
}

export interface ReviewGateInput {
  work: WorkItem;
  verdict: ReviewVerdict;
  reviewer: string;
}

/** 多個閘門同時失敗時，回報最根本的那一個；其餘放在 blockedBy。 */
const CODE_PRIORITY: Record<string, number> = {
  INVALID_TRANSITION: 0,
  ACCEPTANCE_INCOMPLETE: 1,
  EVIDENCE_REQUIRED: 2,
  DEPENDENCY_NOT_DONE: 3,
  REVIEW_REQUIRED: 4,
  REVIEWER_IS_OWNER: 4,
  REVIEW_STALE: 5,
  SERVER_EVIDENCE_REQUIRED: 6,
  SERVER_EVIDENCE_FAILED: 6,
  WORK_NOT_FOUND: 7,
  VERSION_CONFLICT: 7,
  IDEMPOTENCY_CONFLICT: 7,
};

export function primaryIssue(issues: readonly GateIssue[]): GateIssue | null {
  let primary: GateIssue | null = null;
  for (const issue of issues) {
    const current = CODE_PRIORITY[issue.code] ?? Number.MAX_SAFE_INTEGER;
    const best = primary ? (CODE_PRIORITY[primary.code] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (!primary || current < best) primary = issue;
  }
  return primary;
}

interface AcceptanceIndex {
  expected: string[];
  provided: Map<string, AcceptanceResultItem[]>;
  missing: string[];
  unknown: string[];
  duplicates: string[];
  unmet: string[];
}

function indexAcceptance(work: WorkItem, results: readonly AcceptanceResultItem[]): AcceptanceIndex {
  const expected = work.acceptance.map((criterion) => criterion.trim());
  const expectedSet = new Set(expected);
  const provided = new Map<string, AcceptanceResultItem[]>();

  for (const item of results) {
    const key = item.criterion.trim();
    const existing = provided.get(key);
    if (existing) existing.push(item);
    else provided.set(key, [item]);
  }

  const missing = expected.filter((criterion) => !provided.has(criterion));
  const unknown = [...provided.keys()].filter((criterion) => !expectedSet.has(criterion));
  const duplicates = expected.filter((criterion) => (provided.get(criterion)?.length ?? 0) > 1);
  const unmet = expected.filter((criterion) => {
    const items = provided.get(criterion);
    return items?.length === 1 && items[0]?.met === false;
  });

  return { expected, provided, missing, unknown, duplicates, unmet };
}

function nextStepForCompletion(status: WorkStatus): string {
  switch (status) {
    case "open":
      return "先用 work_update 把工作轉到 in_progress；完成後用 work_review 記錄審查，再結案。";
    case "in_progress":
      return "先用 work_review 記錄審查，把工作推進到 review，再結案。";
    case "blocked":
      return "先解除阻擋並轉回 in_progress；完成後用 work_review 記錄審查，再結案。";
    case "done":
    case "cancelled":
      return "工作已經在終態，不能變更；需要新工作時請另建一項。";
    case "review":
      return "工作已經在 review 狀態。";
  }
}

function transitionIssue(work: WorkItem): GateIssue | null {
  if (work.status === "review") return null;
  return {
    code: WORK_ERROR_CODES.invalidTransition,
    message: `工作目前的狀態是 ${work.status}，只有 review 狀態可以結案。`,
    nextAction: nextStepForCompletion(work.status),
    data: { currentStatus: work.status, requiredStatus: "review" },
  };
}

function acceptanceIssue(index: AcceptanceIndex): GateIssue | null {
  const { missing, unknown, duplicates, unmet } = index;
  if (missing.length === 0 && unknown.length === 0 && duplicates.length === 0 && unmet.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`缺少 ${missing.length} 條驗收結果`);
  if (unknown.length > 0) parts.push(`有 ${unknown.length} 條不屬於這個工作`);
  if (duplicates.length > 0) parts.push(`有 ${duplicates.length} 條重複回報`);
  if (unmet.length > 0) parts.push(`有 ${unmet.length} 條未達成`);

  return {
    code: WORK_ERROR_CODES.acceptanceIncomplete,
    message: `驗收結果不完整：${parts.join("、")}。`,
    nextAction: "用 work_get 讀取完整驗收條件，逐項回報結果，並把未達成的項目處理到 met=true。",
    data: { missing, unknown, duplicates, unmet },
  };
}

function evidenceIssue(
  index: AcceptanceIndex,
  evidence: readonly EvidenceReference[],
): GateIssue | null {
  const known = new Map(evidence.map((item) => [item.evidenceId, item]));
  const criteriaWithoutEvidence: string[] = [];
  const missingEvidenceIds: string[] = [];
  const seenMissing = new Set<string>();

  for (const criterion of index.expected) {
    const items = index.provided.get(criterion);
    if (!items || items.length !== 1) continue;
    const item = items[0];
    if (!item || !item.met) continue;

    if (item.evidenceIds.length === 0) {
      criteriaWithoutEvidence.push(criterion);
      continue;
    }
    for (const evidenceId of item.evidenceIds) {
      if (!known.has(evidenceId) && !seenMissing.has(evidenceId)) {
        seenMissing.add(evidenceId);
        missingEvidenceIds.push(evidenceId);
      }
    }
  }

  if (criteriaWithoutEvidence.length === 0 && missingEvidenceIds.length === 0) return null;

  return {
    code: WORK_ERROR_CODES.evidenceRequired,
    message: "已達成的驗收條件缺少可追查的證據。",
    nextAction: "先用 verify_run 或 work_update 建立證據，再把 evidenceId 填進對應的驗收結果。",
    data: { criteriaWithoutEvidence, missingEvidenceIds },
  };
}

function dependencyIssue(dependencies: readonly DependencyReference[]): GateIssue | null {
  const unfinished = dependencies.filter((dependency) => dependency.status !== "done");
  if (unfinished.length === 0) return null;

  const cancelled = unfinished.filter((dependency) => dependency.status === "cancelled");
  const pending = unfinished.filter((dependency) => dependency.status !== "cancelled");

  let nextAction = "先完成所有依賴，再重新結案。";
  if (cancelled.length > 0 && pending.length > 0) {
    nextAction = "先完成尚未完成的依賴；已取消的依賴請移除（work_update 的 removeDependsOn），或取消本項工作。";
  } else if (cancelled.length > 0) {
    nextAction = "移除已取消的依賴（work_update 的 removeDependsOn），或取消本項工作。";
  }

  return {
    code: WORK_ERROR_CODES.dependencyNotDone,
    message: `還有 ${unfinished.length} 個依賴沒有完成。`,
    nextAction,
    data: {
      dependencies: unfinished.map((dependency) => ({
        workId: dependency.workId,
        title: dependency.title,
        status: dependency.status,
      })),
      cancelled: cancelled.map((dependency) => dependency.workId),
    },
  };
}

/** 沒有結束碼的舊證據視為可用；逾時或非 0 結束碼則視為失敗。 */
function isSuccessfulServerEvidence(item: EvidenceReference): boolean {
  if (item.timedOut) return false;
  return item.exitCode === null || item.exitCode === 0;
}

function highRiskReviewIssues(
  work: WorkItem,
  evidence: readonly EvidenceReference[],
): GateIssue[] {
  if (work.risk !== "high") return [];

  const issues: GateIssue[] = [];
  const review = work.review;

  if (!review) {
    issues.push({
      code: WORK_ERROR_CODES.reviewRequired,
      message: "這是高風險工作，結案前需要非 owner 的 approve。",
      nextAction: "請非 owner 的審查者用 work_review 記錄 approve 後再結案。",
      data: { risk: work.risk },
    });
  } else if (review.verdict !== "approve") {
    issues.push({
      code: WORK_ERROR_CODES.reviewRequired,
      message: `高風險工作的審查結論是 ${review.verdict}，不是 approve。`,
      nextAction: "處理審查意見後，請非 owner 的審查者重新記錄 approve。",
      data: { verdict: review.verdict, reviewer: review.reviewer, note: review.note ?? null },
    });
  } else if (review.reviewer.trim() === work.owner.trim()) {
    issues.push({
      code: WORK_ERROR_CODES.reviewerIsOwner,
      message: "高風險工作的 approve 不能由 owner 自己記錄。",
      nextAction: "請非 owner 的審查者重新記錄 approve。",
      data: { owner: work.owner, reviewer: review.reviewer },
    });
  } else if (review.reviewedVersion === undefined || review.reviewedVersion < work.version) {
    issues.push({
      code: WORK_ERROR_CODES.reviewStale,
      message: "工作內容在審查之後已經變動，原本的 approve 已經失效。",
      nextAction: "請審查者針對目前版本重新記錄 approve。",
      data: { reviewedVersion: review.reviewedVersion ?? null, currentVersion: work.version },
    });
  }

  const serverEvidence = evidence.filter((item) => item.serverIssued);
  if (serverEvidence.length === 0) {
    issues.push({
      code: WORK_ERROR_CODES.serverEvidenceRequired,
      message: "高風險工作需要至少一個伺服器簽發的證據。",
      nextAction: "先用 verify_run 取得 serverIssued 證據，再重新結案。",
      data: { risk: work.risk },
    });
  } else if (!serverEvidence.some(isSuccessfulServerEvidence)) {
    issues.push({
      code: WORK_ERROR_CODES.serverEvidenceFailed,
      message: "高風險工作的伺服器證據存在，但全部失敗或逾時，不能支撐結案。",
      nextAction: "重新執行 verify_run，取得成功（exitCode 0 且未逾時）的伺服器證據後再結案。",
      data: {
        risk: work.risk,
        evidence: serverEvidence.map((item) => ({
          evidenceId: item.evidenceId,
          exitCode: item.exitCode,
          timedOut: item.timedOut,
        })),
      },
    });
  }

  return issues;
}

/** 結案閘門：狀態、驗收、證據、依賴、高風險審查與伺服器證據。 */
export function evaluateCompletionGates(input: CompletionGateInput): GateIssue[] {
  const issues: GateIssue[] = [];
  const transition = transitionIssue(input.work);
  if (transition) issues.push(transition);

  const index = indexAcceptance(input.work, input.acceptance);
  const acceptance = acceptanceIssue(index);
  if (acceptance) issues.push(acceptance);

  const evidence = evidenceIssue(index, input.evidence);
  if (evidence) issues.push(evidence);

  const dependency = dependencyIssue(input.dependencies);
  if (dependency) issues.push(dependency);

  issues.push(...highRiskReviewIssues(input.work, input.evidence));
  return issues;
}

function reviewTransitionIssue(work: WorkItem): GateIssue | null {
  if (work.status === "in_progress" || work.status === "review") return null;

  let nextAction: string;
  switch (work.status) {
    case "open":
      nextAction = "先用 work_update 把工作轉到 in_progress，再記錄審查。";
      break;
    case "blocked":
      nextAction = "先解除阻擋並轉回 in_progress，再記錄審查。";
      break;
    case "done":
    case "cancelled":
      nextAction = "工作已經在終態，不能變更；需要新工作時請另建一項。";
      break;
  }

  return {
    code: WORK_ERROR_CODES.invalidTransition,
    message: `工作目前的狀態是 ${work.status}，只有 in_progress 或 review 狀態可以記錄審查。`,
    nextAction,
    data: { currentStatus: work.status, allowedStatuses: ["in_progress", "review"] },
  };
}

/** 審查閘門：in_progress 或 review 才能記錄審查，owner 不能 approve 自己的工作。 */
export function evaluateReviewGates(input: ReviewGateInput): GateIssue[] {
  const issues: GateIssue[] = [];
  const transition = reviewTransitionIssue(input.work);
  if (transition) issues.push(transition);

  if (input.verdict === "approve" && input.reviewer.trim() === input.work.owner.trim()) {
    issues.push({
      code: WORK_ERROR_CODES.reviewerIsOwner,
      message: "owner 不能 approve 自己的工作。",
      nextAction: "請非 owner 的審查者記錄 approve；owner 只能記錄 concerns 或 reject。",
      data: { owner: input.work.owner, reviewer: input.reviewer },
    });
  }

  return issues;
}
