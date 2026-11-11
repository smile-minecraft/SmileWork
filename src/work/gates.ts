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

interface AcceptanceSuggestion {
  missing: string;
  reported: string;
  distance: number;
}

interface AcceptanceIndex {
  expected: string[];
  /** 與 expected 平行的陣列，記錄每一條驗收條件對到的回報結果。 */
  matches: AcceptanceResultItem[][];
  missing: string[];
  unknown: string[];
  duplicates: string[];
  unmet: string[];
  suggestions: AcceptanceSuggestion[];
}

/** 驗收字串的比對鍵：NFKC、連續空白收成一個、去掉前後空白。 */
function acceptanceKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** 以 Unicode 字元為單位計算 Levenshtein 距離，代理對不會被算成兩個字。 */
function levenshteinDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? 0;
}

/** 只為真的不一致的缺項提供距離最近的候選，距離太遠就不猜。 */
function acceptanceSuggestions(
  missing: readonly string[],
  unknown: readonly string[],
): AcceptanceSuggestion[] {
  if (unknown.length === 0) return [];

  const suggestions: AcceptanceSuggestion[] = [];
  const seen = new Set<string>();
  for (const criterion of missing) {
    if (seen.has(criterion)) continue;
    seen.add(criterion);

    const limit = criterion.length <= 2 ? 1 : Math.max(2, Math.ceil(criterion.length / 4));
    let closest: AcceptanceSuggestion | null = null;
    for (const reported of unknown) {
      const distance = levenshteinDistance(criterion, reported);
      if (distance > limit) continue;
      if (!closest || distance < closest.distance) {
        closest = { missing: criterion, reported, distance };
      }
    }
    if (closest) suggestions.push(closest);
  }
  return suggestions;
}

function buildAcceptanceIndex(
  acceptance: readonly string[],
  results: readonly AcceptanceResultItem[],
): AcceptanceIndex {
  const expected = acceptance.map((criterion) => criterion.trim());
  const keys = expected.map(acceptanceKey);
  const keyCounts = new Map<string, number>();
  for (const key of keys) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  const exactMatchKeys = new Set(
    [...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );

  const matches: AcceptanceResultItem[][] = expected.map(() => []);
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();

  for (const item of results) {
    const criterion = item.criterion.trim();
    const key = acceptanceKey(item.criterion);
    let matched = false;
    for (let position = 0; position < expected.length; position++) {
      const expectedKey = keys[position]!;
      const isMatch = exactMatchKeys.has(expectedKey)
        ? criterion === expected[position]
        : key === expectedKey;
      if (isMatch) {
        matches[position]!.push(item);
        matched = true;
      }
    }
    if (!matched && !seenUnknown.has(criterion)) {
      seenUnknown.add(criterion);
      unknown.push(criterion);
    }
  }

  const missing = expected.filter((_, position) => matches[position]!.length === 0);
  const duplicates = expected.filter((_, position) => matches[position]!.length > 1);
  const unmet = expected.filter((_, position) => {
    const items = matches[position]!;
    return items.length === 1 && items[0]?.met === false;
  });

  return {
    expected,
    matches,
    missing,
    unknown,
    duplicates,
    unmet,
    suggestions: acceptanceSuggestions(missing, unknown),
  };
}

/**
 * 依工作定義的順序取出每條驗收唯一對應的結果。
 * 回傳的 criterion 保留呼叫端提供的原始字串，只有比對使用正規化 key；
 * 結案寫入與閘門共用同一套比對規則，避免通過閘門後找不到結果。
 */
export function matchAcceptanceResults(
  acceptance: readonly string[],
  results: readonly AcceptanceResultItem[],
): Array<{ criterion: string; result: AcceptanceResultItem }> {
  const index = buildAcceptanceIndex(acceptance, results);
  return index.expected.map((criterion, position) => {
    const matched = index.matches[position] ?? [];
    const [result] = matched;
    if (matched.length !== 1 || !result) {
      throw new Error(`驗收條件「${criterion}」在閘門通過後沒有唯一對應的結果。`);
    }
    return { criterion: acceptance[position]!, result };
  });
}

function completeStep(work: WorkItem, version: number): string {
  return `用 work_complete（id: ${work.workId}, expectedVersion: ${version}）結案。`;
}

function reviewThenCompleteStep(work: WorkItem, inProgressVersion: number): string {
  return `用 work_review（id: ${work.workId}, expectedVersion: ${inProgressVersion}, verdict: approve）請非 owner 的審查者記錄 approve，再${completeStep(work, inProgressVersion + 1)}`;
}

function completionAllowed(work: WorkItem): boolean {
  if (work.status === "review") return true;
  return work.status === "in_progress" && work.risk !== "high";
}

function transitionIssue(work: WorkItem): GateIssue | null {
  if (completionAllowed(work)) return null;

  if (work.status === "in_progress") {
    // 走到這裡只剩高風險工作：in_progress 直接結案只開放給非高風險。
    return {
      code: WORK_ERROR_CODES.invalidTransition,
      message: "這是高風險工作，從 in_progress 結案前需要非 owner 的審查者 approve。",
      nextAction: `先${reviewThenCompleteStep(work, work.version)}`,
      data: { currentStatus: work.status, requiredStatus: "review", risk: work.risk },
    };
  }

  const updateStep = `用 work_update（id: ${work.workId}, expectedVersion: ${work.version}）`;

  switch (work.status) {
    case "review":
      return null;
    case "open":
      return {
        code: WORK_ERROR_CODES.invalidTransition,
        message: "工作目前的狀態是 open，必須先轉到 in_progress 才能結案。",
        nextAction:
          work.risk === "high"
            ? `先${updateStep}把工作轉到 in_progress，再${reviewThenCompleteStep(work, work.version + 1)}`
            : `先${updateStep}把工作轉到 in_progress，再${completeStep(work, work.version + 1)}`,
        data: { currentStatus: work.status, requiredStatus: "in_progress" },
      };
    case "blocked":
      return {
        code: WORK_ERROR_CODES.invalidTransition,
        message: "工作目前的狀態是 blocked，不能直接結案。",
        nextAction:
          work.risk === "high"
            ? `先解除阻擋，並${updateStep}轉回 in_progress，再${reviewThenCompleteStep(work, work.version + 1)}`
            : `先解除阻擋，並${updateStep}轉回 in_progress，再${completeStep(work, work.version + 1)}`,
        data: { currentStatus: work.status, requiredStatus: "in_progress" },
      };
    case "done":
    case "cancelled":
      return {
        code: WORK_ERROR_CODES.invalidTransition,
        message: `工作目前的狀態是 ${work.status}，不能結案。`,
        nextAction: "工作已經在終態，不能變更；需要新工作時請另建一項。",
        data: { currentStatus: work.status },
      };
  }
}

function acceptanceIssue(index: AcceptanceIndex): GateIssue | null {
  const { missing, unknown, duplicates, unmet, suggestions } = index;
  if (missing.length === 0 && unknown.length === 0 && duplicates.length === 0 && unmet.length === 0) {
    return null;
  }

  const suggestionByMissing = new Map(
    suggestions.map((suggestion) => [suggestion.missing, suggestion]),
  );
  const orderedMissing = [
    ...missing.filter((criterion) => suggestionByMissing.has(criterion)),
    ...missing.filter((criterion) => !suggestionByMissing.has(criterion)),
  ];
  const listed = orderedMissing.slice(0, 3);

  const parts: string[] = [];
  for (const criterion of listed) {
    const suggestion = suggestionByMissing.get(criterion);
    parts.push(
      suggestion
        ? `缺少「${criterion}」；最接近的回報是「${suggestion.reported}」（差 ${suggestion.distance} 個字）`
        : `缺少「${criterion}」`,
    );
  }
  if (missing.length > listed.length) parts.push(`另有 ${missing.length - listed.length} 條缺少`);
  if (unknown.length > 0) parts.push(`有 ${unknown.length} 條不屬於這個工作`);
  if (duplicates.length > 0) parts.push(`有 ${duplicates.length} 條重複回報`);
  if (unmet.length > 0) parts.push(`有 ${unmet.length} 條未達成`);

  const actions: string[] = [];
  if (missing.length > 0) actions.push("缺少的項目先用 work_get 讀取完整驗收條件，逐項補上回報");
  if (unknown.length > 0) actions.push("不屬於工作的項目改成工作定義的驗收字串");
  if (unmet.length > 0) actions.push("未達成的項目處理到 met=true");
  if (duplicates.length > 0) actions.push("重複回報的項目只保留一筆");

  return {
    code: WORK_ERROR_CODES.acceptanceIncomplete,
    message: `驗收結果不完整：${parts.join("；")}。`,
    nextAction: `${actions.join("；")}。`,
    data: { missing, unknown, duplicates, unmet, suggestions },
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

  for (const [position, criterion] of index.expected.entries()) {
    const items = index.matches[position] ?? [];
    if (items.length !== 1) continue;
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

/** 低風險免審查不能繞過目前在這個版本上仍然有效的 reject。 */
function rejectedReviewIssue(work: WorkItem): GateIssue | null {
  if (work.risk === "high") return null;

  const review = work.review;
  if (!review || review.verdict !== "reject") return null;
  if (review.reviewedVersion === undefined || review.reviewedVersion < work.version) return null;

  return {
    code: WORK_ERROR_CODES.reviewRequired,
    message: "最近一次審查的結論是 reject，不能直接結案。",
    nextAction: "先處理審查意見，再由審查者用 work_review 記錄新的 approve 或 concerns 結論。",
    data: {
      verdict: review.verdict,
      reviewer: review.reviewer,
      reviewedVersion: review.reviewedVersion,
      currentVersion: work.version,
    },
  };
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

  const index = buildAcceptanceIndex(input.work.acceptance, input.acceptance);
  const acceptance = acceptanceIssue(index);
  if (acceptance) issues.push(acceptance);

  const evidence = evidenceIssue(index, input.evidence);
  if (evidence) issues.push(evidence);

  const dependency = dependencyIssue(input.dependencies);
  if (dependency) issues.push(dependency);

  const rejected = rejectedReviewIssue(input.work);
  if (rejected) issues.push(rejected);

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
