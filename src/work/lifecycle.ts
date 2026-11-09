import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "../db/transaction.ts";
import type { Actor } from "../domain/actor.ts";
import type {
  AcceptanceResultItem,
  AcceptanceResults,
  ReviewVerdict,
  RiskLevel,
  WorkItem,
  WorkKind,
  WorkResolution,
  WorkReview,
  WorkStatus,
} from "../domain/work.ts";
import { newId, sha256Hex } from "../shared/hash.ts";
import { fail, ok, type ToolResult } from "../shared/result.ts";
import {
  parseStoredJson,
  parseStoredObject,
  parseStoredStringArray,
  parseStoredToolResult,
} from "../shared/stored-json.ts";
import { nowIso } from "../shared/time.ts";
import { loadWorkContinuity } from "./continuity.ts";
import {
  evaluateCompletionGates,
  evaluateReviewGates,
  primaryIssue,
  WORK_ERROR_CODES,
  type DependencyReference,
  type EvidenceReference,
  type GateIssue,
} from "./gates.ts";

const COMPLETE_TOOL = "work_complete";

export interface CompleteWorkInput {
  id: string;
  expectedVersion: number;
  acceptance: AcceptanceResultItem[];
  note?: string;
  idempotencyKey?: string;
}

export interface ReviewWorkInput {
  id: string;
  expectedVersion: number;
  verdict: ReviewVerdict;
  note?: string;
  reviewer?: string;
}

interface WorkRow {
  work_id: string;
  project_id: string;
  kind: string;
  title: string;
  status: string;
  resolution: string | null;
  owner: string;
  priority: string;
  plan_id: string | null;
  objective: string | null;
  non_goals: string;
  context_refs: string;
  scope_paths: string;
  acceptance: string;
  risk: string | null;
  review: string | null;
  reviewed_version: number | null;
  acceptance_results: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

interface EvidenceRow {
  evidenceId: string;
  serverIssued: number;
  exitCode: number | null;
  details: string | null;
}

interface DependencyRow {
  workId: string;
  title: string;
  status: string;
}

interface IdempotencyRow {
  request_hash: string;
  response: string;
}

function parseJson(value: string | null, workId: string, column: string): unknown {
  return parseStoredJson(value, { entity: "工作", id: workId, field: column });
}

function parseStringArray(value: string | null, workId: string, column: string): string[] {
  return parseStoredStringArray(value, { entity: "工作", id: workId, field: column });
}

function parseReview(
  value: string | null,
  reviewedVersion: number | null,
  workId: string,
): WorkReview | null {
  const parsed = parseJson(value, workId, "review");
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== "approve" && verdict !== "concerns" && verdict !== "reject") return null;

  const review: WorkReview = {
    verdict,
    reviewer:
      typeof record.reviewer === "string" && record.reviewer.trim() ? record.reviewer : "unknown",
    reviewedVersion: reviewedVersion ?? undefined,
  };
  if (typeof record.note === "string") review.note = record.note;
  if (typeof record.reviewedAt === "string") review.reviewedAt = record.reviewedAt;
  if (record.reworkedAfterReview === true) review.reworkedAfterReview = true;
  return review;
}

function parseAcceptanceResults(
  value: string | null,
  workId: string,
): AcceptanceResults | null {
  const parsed = parseJson(value, workId, "acceptance_results");
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items: AcceptanceResultItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.criterion !== "string" || typeof item.met !== "boolean") continue;
    const evidenceIds = Array.isArray(item.evidenceIds)
      ? item.evidenceIds.filter((evidenceId): evidenceId is string => typeof evidenceId === "string")
      : [];
    items.push({ criterion: item.criterion, met: item.met, evidenceIds });
  }

  const results: AcceptanceResults = {
    recordedBy: typeof record.recordedBy === "string" ? record.recordedBy : "unknown",
    items,
  };
  if (typeof record.recordedAt === "string") results.recordedAt = record.recordedAt;
  return results;
}

function mapWorkRow(row: WorkRow): WorkItem {
  return {
    workId: row.work_id,
    projectId: row.project_id,
    kind: row.kind as WorkKind,
    title: row.title,
    status: row.status as WorkStatus,
    resolution: row.resolution as WorkResolution | null,
    owner: row.owner,
    priority: row.priority,
    planId: row.plan_id,
    objective: row.objective,
    nonGoals: parseStringArray(row.non_goals, row.work_id, "non_goals"),
    contextRefs: parseStringArray(row.context_refs, row.work_id, "context_refs"),
    scopePaths: parseStringArray(row.scope_paths, row.work_id, "scope_paths"),
    acceptance: parseStringArray(row.acceptance, row.work_id, "acceptance"),
    risk: row.risk as RiskLevel | null,
    review: parseReview(row.review, row.reviewed_version, row.work_id),
    acceptanceResults: parseAcceptanceResults(row.acceptance_results, row.work_id),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function loadWork(db: Database, projectId: string, workId: string): WorkItem | null {
  const row = db
    .query<WorkRow, [string, string]>(
      "SELECT * FROM work_items WHERE work_id = ? AND project_id = ?",
    )
    .get(workId, projectId);
  return row ? mapWorkRow(row) : null;
}

function parseEvidenceTimedOut(details: string | null, evidenceId: string): boolean {
  const parsed = parseStoredObject(details, { entity: "證據", id: evidenceId, field: "details" });
  return parsed?.timedOut === true;
}

function loadEvidence(db: Database, projectId: string, workId: string): EvidenceReference[] {
  return db
    .query<EvidenceRow, [string, string]>(
      `SELECT evidence_id AS evidenceId, server_issued AS serverIssued, exit_code AS exitCode, details
       FROM evidence WHERE project_id = ? AND work_id = ?`,
    )
    .all(projectId, workId)
    .map((row) => ({
      evidenceId: row.evidenceId,
      serverIssued: row.serverIssued === 1,
      exitCode: row.exitCode,
      timedOut: parseEvidenceTimedOut(row.details, row.evidenceId),
    }));
}

function loadDependencies(db: Database, workId: string): DependencyReference[] {
  return db
    .query<DependencyRow, [string]>(
      `SELECT d.depends_on_work_id AS workId, w.title, w.status
       FROM work_dependencies d
       JOIN work_items w ON w.work_id = d.depends_on_work_id
       WHERE d.work_id = ?
       ORDER BY d.depends_on_work_id`,
    )
    .all(workId)
    .map((row) => ({
      workId: row.workId,
      title: row.title,
      status: row.status as WorkStatus,
    }));
}

function workNotFound(workId: string): ToolResult {
  return fail(
    WORK_ERROR_CODES.workNotFound,
    `找不到工作 ${workId}。`,
    "確認 work id 是否正確，或先用 work_create 建立工作。",
    { workId },
  );
}

function versionConflict(work: WorkItem): ToolResult {
  return fail(
    WORK_ERROR_CODES.versionConflict,
    `工作 ${work.workId} 的版本不符，目前是 ${work.version}。`,
    "重新讀取工作取得目前版本後再試一次。",
    {
      workId: work.workId,
      currentVersion: work.version,
      current: {
        status: work.status,
        title: work.title,
        owner: work.owner,
        risk: work.risk,
        acceptance: work.acceptance,
      },
    },
  );
}

function gateFailure(work: WorkItem, issues: readonly GateIssue[], primary: GateIssue): ToolResult {
  return fail(primary.code, primary.message, primary.nextAction, {
    ...primary.data,
    workId: work.workId,
    currentVersion: work.version,
    blockedBy: issues.map((issue) => issue.code),
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      nextAction: issue.nextAction,
    })),
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) sorted[key] = normalizeJson(item);
    }
    return sorted;
  }
  return value;
}

function readIdempotency(
  db: Database,
  projectId: string,
  tool: string,
  key: string,
  requestHash: string,
): ToolResult | null {
  const row = db
    .query<IdempotencyRow, [string, string, string]>(
      "SELECT request_hash, response FROM idempotency_keys WHERE project_id = ? AND tool = ? AND key = ?",
    )
    .get(projectId, tool, key);
  if (!row) return null;

  if (row.request_hash !== requestHash) {
    return fail(
      WORK_ERROR_CODES.idempotencyConflict,
      "同一個 idempotencyKey 已經用在不同的請求內容。",
      "換一個 idempotencyKey，或沿用原本的請求內容重送。",
      { tool, key },
    );
  }

  return parseStoredResult(row.response, key);
}

function parseStoredResult(value: string, key: string): ToolResult {
  return parseStoredToolResult(value, { tool: COMPLETE_TOOL, key });
}

function writeIdempotency(
  db: Database,
  projectId: string,
  tool: string,
  key: string,
  requestHash: string,
  result: ToolResult,
  createdAt: string,
): void {
  db.query(
    "INSERT INTO idempotency_keys (project_id, tool, key, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(projectId, tool, key, requestHash, JSON.stringify(result), createdAt);
}

interface EventInput {
  kind: string;
  actor: Actor;
  workId: string;
  fromStatus: string | null;
  toStatus: string | null;
  resolution: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

function insertEvent(db: Database, projectId: string, event: EventInput): void {
  const next = db
    .query<{ sequence: number }, [string]>(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE project_id = ?",
    )
    .get(projectId);
  const sequence = next?.sequence ?? 1;

  db.query(
    `INSERT INTO events (
       event_id, project_id, sequence, kind, actor, actor_model, work_id,
       from_status, to_status, resolution, summary, details, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("event"),
    projectId,
    sequence,
    event.kind,
    event.actor.name,
    event.actor.model,
    event.workId,
    event.fromStatus,
    event.toStatus,
    event.resolution,
    event.summary,
    JSON.stringify(event.details),
    event.createdAt,
  );
}

function completeWorkInTransaction(
  db: Database,
  projectId: string,
  actor: Actor,
  input: CompleteWorkInput,
): ToolResult {
  const requestHash = input.idempotencyKey
    ? sha256Hex(canonicalJson({ ...input, idempotencyKey: undefined }))
    : null;

  if (input.idempotencyKey && requestHash) {
    const cached = readIdempotency(db, projectId, COMPLETE_TOOL, input.idempotencyKey, requestHash);
    if (cached) return cached;
  }

  const work = loadWork(db, projectId, input.id);
  if (!work) return workNotFound(input.id);
  if (work.version !== input.expectedVersion) return versionConflict(work);

  const issues = evaluateCompletionGates({
    work,
    acceptance: input.acceptance,
    evidence: loadEvidence(db, projectId, work.workId),
    dependencies: loadDependencies(db, work.workId),
  });
  const primary = primaryIssue(issues);
  if (primary) {
    if (primary.code === WORK_ERROR_CODES.invalidTransition && work.status !== "review") {
      return gateFailure(work, issues, {
        ...primary,
        nextAction: `先用 work_review（id: ${work.workId}, expectedVersion: ${work.version}, verdict: approve 或 reject）把工作推進到 review，再用 work_complete（expectedVersion: ${work.version + 1}）結案。`,
      });
    }
    return gateFailure(work, issues, primary);
  }

  const byCriterion = new Map<string, AcceptanceResultItem>();
  for (const item of input.acceptance) byCriterion.set(item.criterion.trim(), item);

  const completedAt = nowIso();
  const items: AcceptanceResultItem[] = work.acceptance.map((criterion) => {
    const item = byCriterion.get(criterion.trim());
    if (!item) throw new Error(`驗收條件 ${criterion} 在閘門通過後找不到結果。`);
    return { criterion, met: item.met, evidenceIds: unique(item.evidenceIds) };
  });
  const acceptanceResults: AcceptanceResults | null =
    items.length === 0
      ? null
      : {
          recordedBy: actor.name,
          recordedAt: completedAt,
          items,
        };

  const newVersion = work.version + 1;
  const updated = db
    .query(
      `UPDATE work_items
       SET status = 'done', resolution = 'completed', acceptance_results = ?,
           version = ?, updated_at = ?, updated_by = ?, updated_by_model = ?
       WHERE work_id = ? AND project_id = ? AND version = ?`,
    )
    .run(
      acceptanceResults ? JSON.stringify(acceptanceResults) : null,
      newVersion,
      completedAt,
      actor.name,
      actor.model,
      work.workId,
      projectId,
      work.version,
    );

  if (updated.changes === 0) return versionConflict(work);

  const details: Record<string, unknown> = acceptanceResults ? { acceptanceResults } : {};
  const note = input.note?.trim();
  if (note) details.note = note;

  insertEvent(db, projectId, {
    kind: "status_changed",
    actor,
    workId: work.workId,
    fromStatus: work.status,
    toStatus: "done",
    resolution: "completed",
    summary: "工作已結案。",
    details,
    createdAt: completedAt,
  });

  const continuity = loadWorkContinuity(db, projectId, work.workId);
  const result = ok("工作已結案。", {
    workId: work.workId,
    status: "done",
    resolution: "completed",
    version: newVersion,
    acceptanceResults,
    handoff: continuity.handoff,
    rulings: continuity.rulings,
    completedAt,
  });

  if (input.idempotencyKey && requestHash) {
    writeIdempotency(
      db,
      projectId,
      COMPLETE_TOOL,
      input.idempotencyKey,
      requestHash,
      result,
      completedAt,
    );
  }

  return result;
}

/** 結案：所有閘門通過後才把工作標成 done，並在同一筆交易寫入事件與冪等紀錄。 */
export function completeWork(
  db: Database,
  projectId: string,
  actor: Actor,
  input: CompleteWorkInput,
): ToolResult {
  return withImmediateTransaction(db, () => completeWorkInTransaction(db, projectId, actor, input));
}

function reviewWorkInTransaction(
  db: Database,
  projectId: string,
  actor: Actor,
  input: ReviewWorkInput,
): ToolResult {
  const work = loadWork(db, projectId, input.id);
  if (!work) return workNotFound(input.id);
  if (work.version !== input.expectedVersion) return versionConflict(work);

  const reviewer = input.reviewer?.trim() || actor.name;
  const issues = evaluateReviewGates({ work, verdict: input.verdict, reviewer });
  const primary = primaryIssue(issues);
  if (primary) return gateFailure(work, issues, primary);

  const reviewedAt = nowIso();
  const note = input.note?.trim();
  const newVersion = work.version + 1;
  const storedReview: WorkReview = {
    verdict: input.verdict,
    reviewer,
    ...(note ? { note } : {}),
    reviewedAt,
    reviewedVersion: newVersion,
  };

  const updated = db
    .query(
      `UPDATE work_items
       SET review = ?, reviewed_version = ?, status = 'review', version = ?,
           updated_at = ?, updated_by = ?, updated_by_model = ?
       WHERE work_id = ? AND project_id = ? AND version = ?`,
    )
    .run(
      JSON.stringify(storedReview),
      newVersion,
      newVersion,
      reviewedAt,
      actor.name,
      actor.model,
      work.workId,
      projectId,
      work.version,
    );

  if (updated.changes === 0) return versionConflict(work);

  if (work.status !== "review") {
    insertEvent(db, projectId, {
      kind: "status_changed",
      actor,
      workId: work.workId,
      fromStatus: work.status,
      toStatus: "review",
      resolution: null,
      summary: "工作進入審查。",
      details: {},
      createdAt: reviewedAt,
    });
  }

  insertEvent(db, projectId, {
    kind: "reviewed",
    actor,
    workId: work.workId,
    fromStatus: null,
    toStatus: null,
    resolution: null,
    summary: `審查結論：${input.verdict}`,
    details: {
      verdict: input.verdict,
      reviewer,
      ...(note ? { note } : {}),
      reviewedVersion: newVersion,
    },
    createdAt: reviewedAt,
  });

  const continuity = loadWorkContinuity(db, projectId, work.workId);
  return ok("已記錄審查結論。", {
    workId: work.workId,
    status: "review",
    verdict: input.verdict,
    reviewer,
    note: note ?? null,
    handoff: continuity.handoff,
    rulings: continuity.rulings,
    reviewedAt,
    reviewedVersion: newVersion,
    version: newVersion,
  });
}

/** 審查會把工作推進到 review 並提高版本；之後任何欄位變動都會讓這筆結論過期。 */
export function reviewWork(
  db: Database,
  projectId: string,
  actor: Actor,
  input: ReviewWorkInput,
): ToolResult {
  return withImmediateTransaction(db, () => reviewWorkInTransaction(db, projectId, actor, input));
}
