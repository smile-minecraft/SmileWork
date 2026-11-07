import type { Database } from "bun:sqlite";
import type { ZodType } from "zod";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  type AcceptanceResults,
  type Actor,
  type ProjectContext,
  type RiskLevel,
  type WorkKind,
  type WorkPriority,
  type WorkResolution,
  type WorkReview,
  type WorkStatus,
} from "../domain/index.ts";
import { updateVersionedRow } from "../db/optimistic.ts";
import { withImmediateTransaction } from "../db/transaction.ts";
import { isProjectResolutionError } from "../mcp/context.ts";
import type { ToolContext } from "../mcp/types.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { newId, sha256Hex } from "../shared/hash.ts";
import { ok, type ToolResult } from "../shared/result.ts";
import { nowIso } from "../shared/time.ts";

/** 工作工具對外承諾的錯誤碼；其他工具的錯誤碼留在各自的模組。 */
export const WORK_ERROR_CODES = {
  validation: "VALIDATION_ERROR",
  projectUnresolved: "PROJECT_UNRESOLVED",
  workNotFound: "WORK_NOT_FOUND",
  versionConflict: "VERSION_CONFLICT",
  dependencyCycle: "DEPENDENCY_CYCLE",
  invalidTransition: "INVALID_TRANSITION",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
} as const;

type SqlValue = string | number | boolean | null;

export interface WorkView {
  id: string;
  projectId: string;
  kind: WorkKind;
  parentId: string | null;
  title: string;
  objective: string | null;
  nonGoals: string[];
  contextRefs: string[];
  scopePaths: string[];
  acceptance: string[];
  status: WorkStatus;
  resolution: WorkResolution | null;
  risk: RiskLevel | null;
  priority: string;
  labels: string[];
  owner: string;
  dependsOn: string[];
  review: WorkReview | null;
  acceptanceResults: AcceptanceResults | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceView {
  evidenceId: string;
  kind: string;
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

export interface DependencySummary {
  id: string;
  title: string;
  status: WorkStatus;
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
  created_by_model: string | null;
  updated_by: string;
  updated_by_model: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  kind: string;
  actor: string;
  actor_model: string | null;
  summary: string;
  command: string | null;
  output: string | null;
  output_path: string | null;
  url: string | null;
  path: string | null;
  sha256: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  server_issued: number;
  details: string | null;
  created_at: string;
}

/**
 * work_items 目前沒有 labels 欄位，標籤先存在 metadata 的專用鍵。
 * 之後 schema 補上欄位時，再把這個相容層換掉。
 */
const LABELS_KEY_PREFIX = "work_labels:";

/** 把工具輸入換成固定錯誤碼，讓 MCP 外框不必猜測驗證失敗的原因。 */
export function parseToolInput<TOutput>(schema: ZodType<TOutput>, input: unknown): TOutput {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const detail = issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("；");
  throw new SmileworkError(
    WORK_ERROR_CODES.validation,
    `輸入格式不正確：${detail}`,
    "依錯誤訊息修正參數後重新呼叫。",
    { issues },
  );
}

/** 寫入類工作工具都需要可解析的專案；解析失敗一律回 PROJECT_UNRESOLVED。 */
export function requireWorkProject(context: ToolContext): ProjectContext {
  try {
    return context.resolveProject();
  } catch (error) {
    if (error instanceof SmileworkError && isProjectResolutionError(error)) {
      throw new SmileworkError(
        WORK_ERROR_CODES.projectUnresolved,
        error.message,
        error.nextAction,
        error.data,
      );
    }
    throw error;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseObject<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function toWorkView(row: WorkRow, dependsOn: string[], labels: string[]): WorkView {
  return {
    id: row.work_id,
    projectId: row.project_id,
    kind: row.kind as WorkKind,
    parentId: row.plan_id,
    title: row.title,
    objective: row.objective,
    nonGoals: parseStringArray(row.non_goals),
    contextRefs: parseStringArray(row.context_refs),
    scopePaths: parseStringArray(row.scope_paths),
    acceptance: parseStringArray(row.acceptance),
    status: row.status as WorkStatus,
    resolution: row.resolution as WorkResolution | null,
    risk: row.risk as RiskLevel | null,
    priority: row.priority,
    labels,
    owner: row.owner,
    dependsOn,
    review: parseObject<WorkReview>(row.review),
    acceptanceResults: parseObject<AcceptanceResults>(row.acceptance_results),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvidenceView(row: EvidenceRow): EvidenceView {
  return {
    evidenceId: row.evidence_id,
    kind: row.kind,
    actor: row.actor,
    actorModel: row.actor_model,
    summary: row.summary,
    command: row.command,
    output: row.output,
    outputPath: row.output_path,
    url: row.url,
    path: row.path,
    sha256: row.sha256,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    serverIssued: row.server_issued === 1,
    details: parseObject<Record<string, unknown>>(row.details),
    createdAt: row.created_at,
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function loadDependsOn(db: Database, workIds: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  if (workIds.length === 0) return grouped;
  const rows = db
    .query<{ work_id: string; depends_on_work_id: string }, string[]>(
      `SELECT work_id, depends_on_work_id
       FROM work_dependencies
       WHERE work_id IN (${placeholders(workIds.length)})
       ORDER BY depends_on_work_id`,
    )
    .all(...workIds);
  for (const row of rows) {
    const list = grouped.get(row.work_id) ?? [];
    list.push(row.depends_on_work_id);
    grouped.set(row.work_id, list);
  }
  return grouped;
}

function loadLabels(db: Database, workIds: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  if (workIds.length === 0) return grouped;
  const keys = workIds.map((workId) => `${LABELS_KEY_PREFIX}${workId}`);
  const rows = db
    .query<{ key: string; value: string }, string[]>(
      `SELECT key, value FROM metadata WHERE key IN (${placeholders(keys.length)})`,
    )
    .all(...keys);
  for (const row of rows) {
    if (!row.key.startsWith(LABELS_KEY_PREFIX)) continue;
    grouped.set(row.key.slice(LABELS_KEY_PREFIX.length), parseStringArray(row.value));
  }
  return grouped;
}

/** 依識別碼批次載入工作，回傳順序與輸入一致；找不到的略過。 */
export function loadWorkViews(db: Database, workIds: readonly string[]): WorkView[] {
  if (workIds.length === 0) return [];
  const rows = db
    .query<WorkRow, string[]>(
      `SELECT * FROM work_items WHERE work_id IN (${placeholders(workIds.length)})`,
    )
    .all(...workIds);
  const byId = new Map(rows.map((row) => [row.work_id, row]));
  const dependsOn = loadDependsOn(db, workIds);
  const labels = loadLabels(db, workIds);
  const views: WorkView[] = [];
  for (const workId of workIds) {
    const row = byId.get(workId);
    if (!row) continue;
    views.push(toWorkView(row, dependsOn.get(workId) ?? [], labels.get(workId) ?? []));
  }
  return views;
}

export function getWorkView(db: Database, projectId: string, workId: string): WorkView | null {
  const row = db
    .query<WorkRow, [string, string]>(
      "SELECT * FROM work_items WHERE project_id = ? AND work_id = ?",
    )
    .get(projectId, workId);
  if (!row) return null;
  return toWorkView(
    row,
    loadDependsOn(db, [workId]).get(workId) ?? [],
    loadLabels(db, [workId]).get(workId) ?? [],
  );
}

function loadEvidence(db: Database, projectId: string, workId: string): EvidenceView[] {
  return db
    .query<EvidenceRow, [string, string]>(
      `SELECT * FROM evidence
       WHERE project_id = ? AND work_id = ?
       ORDER BY created_at, evidence_id`,
    )
    .all(projectId, workId)
    .map(toEvidenceView);
}

function loadDependencySummaries(db: Database, workId: string): DependencySummary[] {
  return db
    .query<{ work_id: string; title: string; status: string }, [string]>(
      `SELECT w.work_id, w.title, w.status
       FROM work_dependencies d
       JOIN work_items w ON w.work_id = d.depends_on_work_id
       WHERE d.work_id = ?
       ORDER BY d.depends_on_work_id`,
    )
    .all(workId)
    .map((row) => ({ id: row.work_id, title: row.title, status: row.status as WorkStatus }));
}

function bulletList(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

/** 從工作欄位產生可以直接交給執行代理的派工說明。 */
export function renderWorkBrief(work: WorkView, dependencies: readonly DependencySummary[]): string {
  const lines: string[] = [];
  lines.push(`# ${work.title}`, "");
  lines.push(`- 工作：${work.id}`);
  lines.push(`- 類型：${work.kind}`);
  lines.push(`- 狀態：${work.status}（v${work.version}）`);
  lines.push(`- 負責人：${work.owner}`);
  lines.push(`- 優先順序：${work.priority}`);
  if (work.risk !== null) lines.push(`- 風險：${work.risk}`);
  if (work.parentId !== null) lines.push(`- 上層：${work.parentId}`);
  if (work.labels.length > 0) lines.push(`- 標籤：${work.labels.join("、")}`);

  lines.push("", "## 目標", "", work.objective ?? "（未填寫）");

  if (work.nonGoals.length > 0) {
    lines.push("", "## 不做的事", "", ...bulletList(work.nonGoals));
  }

  lines.push("", "## 允許修改的範圍", "");
  if (work.scopePaths.length === 0) {
    lines.push("（未填寫）");
  } else {
    lines.push(...work.scopePaths.map((path) => `- \`${path}\``));
  }

  lines.push("", "## 驗收條件", "");
  if (work.acceptance.length === 0) {
    lines.push("（未填寫）");
  } else {
    lines.push(...work.acceptance.map((criterion) => `- [ ] ${criterion}`));
  }

  lines.push("", "## 依賴", "");
  if (dependencies.length === 0) {
    lines.push("無。");
  } else {
    lines.push(
      ...dependencies.map(
        (dependency) => `- ${dependency.id}（${dependency.status}）：${dependency.title}`,
      ),
    );
  }

  if (work.contextRefs.length > 0) {
    lines.push("", "## 相關參照", "", ...bulletList(work.contextRefs));
  }

  return lines.join("\n");
}

export interface WorkDetail {
  work: WorkView;
  evidence: EvidenceView[];
  brief: string;
}

export function getWorkDetail(db: Database, projectId: string, workId: string): WorkDetail {
  const work = getWorkView(db, projectId, workId);
  if (!work) throw workNotFound(workId);
  return {
    work,
    evidence: loadEvidence(db, projectId, workId),
    brief: renderWorkBrief(work, loadDependencySummaries(db, workId)),
  };
}

function workNotFound(workId: string): SmileworkError {
  return new SmileworkError(
    WORK_ERROR_CODES.workNotFound,
    `找不到工作：${workId}`,
    "用 work_list 取得可用的工作 ID，再重新呼叫。",
    { id: workId },
  );
}

function versionConflict(current: WorkView, expectedVersion: number): SmileworkError {
  return new SmileworkError(
    WORK_ERROR_CODES.versionConflict,
    `版本不符：目前版本是 ${current.version}，收到 ${expectedVersion}。`,
    "重新讀取工作，用最新的 version 重新更新。",
    { expectedVersion, currentVersion: current.version, work: current },
  );
}

function invalidTransition(
  from: WorkStatus,
  to: WorkStatus,
  detail: string,
  nextAction: string,
): SmileworkError {
  return new SmileworkError(WORK_ERROR_CODES.invalidTransition, detail, nextAction, {
    from,
    to,
    allowed: ALLOWED_TRANSITIONS[from],
  });
}

function dependencyCycle(cycle: readonly string[]): SmileworkError {
  return new SmileworkError(
    WORK_ERROR_CODES.dependencyCycle,
    `加入依賴會形成循環：${cycle.join(" → ")}`,
    "移除造成循環的依賴後再更新。",
    { cycle: [...cycle] },
  );
}

function validationError(message: string, data: Record<string, unknown> = {}): SmileworkError {
  return new SmileworkError(
    WORK_ERROR_CODES.validation,
    message,
    "依錯誤訊息修正參數後重新呼叫。",
    data,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function hashRequest(input: unknown): string {
  const request = { ...(input as Record<string, unknown>) };
  delete request.idempotencyKey;
  return sha256Hex(canonicalJson(request));
}

interface IdempotencyOptions {
  projectId: string;
  tool: string;
  key: string | undefined;
  request: unknown;
}

/** 同一個 key 只執行一次；重送回傳第一次的成功結果。 */
function runIdempotent(
  db: Database,
  options: IdempotencyOptions,
  run: () => ToolResult,
): ToolResult {
  return withImmediateTransaction(db, () => {
    if (options.key === undefined) return run();
    const requestHash = hashRequest(options.request);
    const existing = db
      .query<{ request_hash: string; response: string }, [string, string, string]>(
        `SELECT request_hash, response FROM idempotency_keys
         WHERE project_id = ? AND tool = ? AND key = ?`,
      )
      .get(options.projectId, options.tool, options.key);

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new SmileworkError(
          WORK_ERROR_CODES.idempotencyConflict,
          `idempotencyKey 已經用在不同的請求內容：${options.key}`,
          "換一個 idempotencyKey，或先用原本的請求內容重送。",
          { key: options.key },
        );
      }
      return JSON.parse(existing.response) as ToolResult;
    }

    const result = run();
    db.query(
      `INSERT INTO idempotency_keys (project_id, tool, key, request_hash, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(options.projectId, options.tool, options.key, requestHash, JSON.stringify(result), nowIso());
    return result;
  });
}

function normalizeStrings(
  values: readonly string[],
  field: string,
  options: { projectPaths?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) throw validationError(`${field} 不能是空白字串。`, { field });
    if (options.projectPaths) assertSafeProjectPath(value, field);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function assertSafeProjectPath(value: string, field: string): void {
  const segments = value.split(/[\\/]/);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || segments.includes("..")) {
    throw validationError(`${field} 必須是專案內的相對路徑：${value}`, { field, value });
  }
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw validationError("title 不能是空白字串。", { field: "title" });
  return title;
}

function normalizeObjective(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const objective = value.trim();
  return objective.length === 0 ? null : objective;
}

function normalizeOwner(value: string | undefined, actor: Actor): string {
  if (value === undefined) return actor.name;
  const owner = value.trim();
  if (owner.length === 0) throw validationError("owner 不能是空白字串。", { field: "owner" });
  return owner;
}

function writeLabels(db: Database, workId: string, labels: readonly string[], now: string): void {
  const key = `${LABELS_KEY_PREFIX}${workId}`;
  if (labels.length === 0) {
    db.query("DELETE FROM metadata WHERE key = ?").run(key);
    return;
  }
  db.query(
    `INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(labels), now);
}

function assertParent(db: Database, projectId: string, parentId: string): void {
  const row = db
    .query<{ kind: string }, [string, string]>(
      "SELECT kind FROM work_items WHERE project_id = ? AND work_id = ?",
    )
    .get(projectId, parentId);
  if (!row) throw workNotFound(parentId);
  if (row.kind !== "plan") {
    throw validationError(`上層工作必須是計畫（plan）：${parentId}`, { parentId, kind: row.kind });
  }
}

function assertDependenciesExist(db: Database, projectId: string, workIds: readonly string[]): void {
  for (const workId of workIds) {
    const row = db
      .query<{ work_id: string }, [string, string]>(
        "SELECT work_id FROM work_items WHERE project_id = ? AND work_id = ?",
      )
      .get(projectId, workId);
    if (!row) throw workNotFound(workId);
  }
}

function loadDependencyGraph(db: Database, projectId: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const rows = db
    .query<{ work_id: string; depends_on_work_id: string }, [string]>(
      `SELECT d.work_id, d.depends_on_work_id
       FROM work_dependencies d
       JOIN work_items w ON w.work_id = d.work_id
       WHERE w.project_id = ?`,
    )
    .all(projectId);
  for (const row of rows) {
    const list = graph.get(row.work_id) ?? [];
    list.push(row.depends_on_work_id);
    graph.set(row.work_id, list);
  }
  return graph;
}

function findDependencyPath(
  graph: ReadonlyMap<string, readonly string[]>,
  from: string,
  target: string,
): string[] | null {
  const stack: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.node === target) return current.path;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    for (const next of graph.get(current.node) ?? []) {
      stack.push({ node: next, path: [...current.path, next] });
    }
  }
  return null;
}

function assertNoDependencyCycle(
  graph: ReadonlyMap<string, readonly string[]>,
  workId: string,
  added: readonly string[],
): void {
  for (const dependency of added) {
    if (dependency === workId) throw dependencyCycle([workId]);
    const path = findDependencyPath(graph, dependency, workId);
    if (path) throw dependencyCycle(path);
  }
}

function appendEvent(
  db: Database,
  input: {
    projectId: string;
    kind: string;
    actor: Actor;
    workId: string | null;
    fromStatus?: WorkStatus | null;
    toStatus?: WorkStatus | null;
    resolution?: WorkResolution | null;
    summary?: string | null;
    details?: Record<string, unknown> | null;
    now: string;
  },
): void {
  const next = db
    .query<{ next: number }, [string]>(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE project_id = ?",
    )
    .get(input.projectId);
  db.query(
    `INSERT INTO events (
       event_id, project_id, sequence, kind, actor, actor_model, work_id,
       from_status, to_status, resolution, summary, details, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("event"),
    input.projectId,
    next?.next ?? 1,
    input.kind,
    input.actor.name,
    input.actor.model,
    input.workId,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.resolution ?? null,
    input.summary ?? null,
    input.details ? JSON.stringify(input.details) : null,
    input.now,
  );
}

export interface CreateWorkInput {
  kind: WorkKind;
  title: string;
  objective?: string;
  nonGoals: string[];
  contextRefs: string[];
  scopePaths: string[];
  acceptance: string[];
  dependsOn: string[];
  parentId?: string;
  priority: WorkPriority;
  risk: RiskLevel;
  labels: string[];
  owner?: string;
  idempotencyKey?: string;
}

export function createWork(
  db: Database,
  project: ProjectContext,
  actor: Actor,
  input: CreateWorkInput,
): ToolResult {
  return runIdempotent(
    db,
    {
      projectId: project.projectId,
      tool: "work_create",
      key: input.idempotencyKey,
      request: input,
    },
    () =>
      withImmediateTransaction(db, () => {
        const title = normalizeTitle(input.title);
        const objective = normalizeObjective(input.objective);
        const nonGoals = normalizeStrings(input.nonGoals, "nonGoals");
        const contextRefs = normalizeStrings(input.contextRefs, "contextRefs");
        const scopePaths = normalizeStrings(input.scopePaths, "scopePaths", { projectPaths: true });
        const acceptance = normalizeStrings(input.acceptance, "acceptance");
        const labels = normalizeStrings(input.labels, "labels");
        const dependsOn = normalizeStrings(input.dependsOn, "dependsOn");
        const owner = normalizeOwner(input.owner, actor);

        if (input.kind === "plan" && input.parentId !== undefined) {
          throw validationError("計畫（plan）不能有 parentId。", { field: "parentId" });
        }
        if (input.parentId !== undefined) assertParent(db, project.projectId, input.parentId);
        assertDependenciesExist(db, project.projectId, dependsOn);

        const workId = newId("work");
        const now = nowIso();
        db.query(
          `INSERT INTO work_items (
             work_id, project_id, kind, title, status, resolution, owner, priority,
             plan_id, objective, non_goals, context_refs, scope_paths, acceptance, risk,
             review, reviewed_version, acceptance_results, version, created_at, updated_at,
             created_by, created_by_model, updated_by, updated_by_model
           ) VALUES (
             ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             NULL, NULL, NULL, 1, ?, ?,
             ?, ?, ?, ?
           )`,
        ).run(
          workId,
          project.projectId,
          input.kind,
          title,
          owner,
          input.priority,
          input.parentId ?? null,
          objective,
          JSON.stringify(nonGoals),
          JSON.stringify(contextRefs),
          JSON.stringify(scopePaths),
          JSON.stringify(acceptance),
          input.risk,
          now,
          now,
          actor.name,
          actor.model,
          actor.name,
          actor.model,
        );

        for (const dependency of dependsOn) {
          db.query(
            "INSERT INTO work_dependencies (work_id, depends_on_work_id, created_at) VALUES (?, ?, ?)",
          ).run(workId, dependency, now);
        }
        writeLabels(db, workId, labels, now);

        appendEvent(db, {
          projectId: project.projectId,
          kind: "created",
          actor,
          workId,
          summary: input.kind === "plan" ? `建立計畫：${title}` : `建立工作：${title}`,
          details: { kind: input.kind, parentId: input.parentId ?? null },
          now,
        });

        const work = getWorkView(db, project.projectId, workId);
        if (!work) {
          throw new SmileworkError(
            ERROR_CODES.internal,
            "工作建立後讀不到資料。",
            "回報這個問題，並附上資料庫與工作 ID。",
            { workId },
          );
        }
        return ok("工作已建立。", { work });
      }),
  );
}

export interface ListWorksInput {
  status?: WorkStatus[];
  owner?: string;
  parentId?: string;
  label?: string;
  kind?: WorkKind;
  limit: number;
  cursor?: string;
}

export interface ListWorksResult {
  items: WorkView[];
  nextCursor: string | null;
}

export function listWorks(
  db: Database,
  projectId: string,
  input: ListWorksInput,
): ListWorksResult {
  const clauses: string[] = ["w.project_id = ?"];
  const params: SqlValue[] = [projectId];

  if (input.status !== undefined && input.status.length > 0) {
    clauses.push(`w.status IN (${placeholders(input.status.length)})`);
    params.push(...input.status);
  } else if (input.status === undefined) {
    clauses.push("w.status NOT IN ('done', 'cancelled')");
  }

  if (input.owner !== undefined) {
    clauses.push("w.owner = ?");
    params.push(input.owner);
  }
  if (input.parentId !== undefined) {
    clauses.push("w.plan_id = ?");
    params.push(input.parentId);
  }
  if (input.kind !== undefined) {
    clauses.push("w.kind = ?");
    params.push(input.kind);
  }
  if (input.label !== undefined) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM metadata m
         WHERE m.key = ? || w.work_id
           AND EXISTS (SELECT 1 FROM json_each(m.value) AS label_value WHERE label_value.value = ?)
       )`,
    );
    params.push(LABELS_KEY_PREFIX, input.label);
  }
  if (input.cursor !== undefined) {
    const anchor = db
      .query<{ created_at: string }, [string, string]>(
        "SELECT created_at FROM work_items WHERE project_id = ? AND work_id = ?",
      )
      .get(projectId, input.cursor);
    if (!anchor) {
      throw validationError(`cursor 指向不存在的工作：${input.cursor}`, { cursor: input.cursor });
    }
    clauses.push("(w.created_at < ? OR (w.created_at = ? AND w.work_id < ?))");
    params.push(anchor.created_at, anchor.created_at, input.cursor);
  }

  const where = clauses.join(" AND ");
  params.push(input.limit + 1);
  const rows = db
    .query<WorkRow, SqlValue[]>(
      `SELECT w.* FROM work_items w
       WHERE ${where}
       ORDER BY w.created_at DESC, w.work_id DESC
       LIMIT ?`,
    )
    .all(...params);

  const page = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;
  const views = loadWorkViews(db, page.map((row) => row.work_id));
  return {
    items: views,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.work_id : null,
  };
}

export type EvidenceInputKind = "verify_run" | "link" | "output" | "note";

export interface EvidenceInput {
  kind: EvidenceInputKind;
  summary: string;
  command?: string;
  output?: string;
  url?: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface UpdateWorkInput {
  id: string;
  expectedVersion: number;
  title?: string;
  objective?: string | null;
  nonGoals?: string[];
  contextRefs?: string[];
  scopePaths?: string[];
  acceptance?: string[];
  status?: WorkStatus;
  owner?: string;
  priority?: WorkPriority;
  risk?: RiskLevel | null;
  labels?: string[];
  parentId?: string | null;
  addDependsOn?: string[];
  removeDependsOn?: string[];
  evidence?: EvidenceInput[];
  idempotencyKey?: string;
}

interface MappedEvidence {
  reportedKind: EvidenceInputKind;
  dbKind: "command" | "link" | "artifact" | "note";
  summary: string;
  command: string | null;
  output: string | null;
  url: string | null;
  path: string | null;
  details: Record<string, unknown> | null;
}

/** 工具對外的證據種類對應到資料庫既有的 kind；人工建立的證據一律 serverIssued=false。 */
function mapEvidence(item: EvidenceInput): MappedEvidence {
  const summary = item.summary.trim();
  if (summary.length === 0) throw validationError("證據的 summary 不能是空白字串。");
  const output = item.output?.trim() ? item.output : null;

  switch (item.kind) {
    case "verify_run": {
      const command = item.command?.trim();
      if (!command) {
        throw validationError("verify_run 證據必須提供 command。", { kind: item.kind });
      }
      return {
        reportedKind: item.kind,
        dbKind: "command",
        summary,
        command,
        output,
        url: null,
        path: null,
        details: item.details ?? null,
      };
    }
    case "link": {
      const url = item.url?.trim();
      if (!url) throw validationError("link 證據必須提供 url。", { kind: item.kind });
      if (!/^https?:\/\//i.test(url)) {
        throw validationError("link 證據的 url 只接受 http:// 或 https://。", {
          kind: item.kind,
          url,
        });
      }
      return {
        reportedKind: item.kind,
        dbKind: "link",
        summary,
        command: null,
        output,
        url,
        path: null,
        details: item.details ?? null,
      };
    }
    case "output": {
      const path = item.path?.trim();
      if (!path) throw validationError("output 證據必須提供 path。", { kind: item.kind });
      assertSafeProjectPath(path, "evidence.path");
      return {
        reportedKind: item.kind,
        dbKind: "artifact",
        summary,
        command: null,
        output,
        url: null,
        path,
        details: item.details ?? null,
      };
    }
    case "note":
      return {
        reportedKind: item.kind,
        dbKind: "note",
        summary,
        command: null,
        output,
        url: null,
        path: null,
        details: item.details ?? null,
      };
  }
}

function insertEvidence(
  db: Database,
  projectId: string,
  actor: Actor,
  workId: string,
  items: readonly EvidenceInput[],
  now: string,
): EvidenceView[] {
  const mapped = items.map(mapEvidence);
  for (const item of mapped) {
    const evidenceId = newId("evidence");
    db.query(
      `INSERT INTO evidence (
         evidence_id, project_id, work_id, kind, actor, actor_model, summary,
         command, output, output_path, url, path, sha256, exit_code, duration_ms,
         server_issued, details, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
    ).run(
      evidenceId,
      projectId,
      workId,
      item.dbKind,
      actor.name,
      actor.model,
      item.summary,
      item.command,
      item.output,
      item.url,
      item.path,
      item.details ? JSON.stringify(item.details) : null,
      now,
    );
    appendEvent(db, {
      projectId,
      kind: "evidence_added",
      actor,
      workId,
      summary: `新增證據：${item.summary}`,
      details: { evidenceId, kind: item.reportedKind },
      now,
    });
  }
  return loadEvidence(db, projectId, workId);
}

export function updateWork(
  db: Database,
  project: ProjectContext,
  actor: Actor,
  input: UpdateWorkInput,
): ToolResult {
  return runIdempotent(
    db,
    {
      projectId: project.projectId,
      tool: "work_update",
      key: input.idempotencyKey,
      request: input,
    },
    () =>
      withImmediateTransaction(db, () => {
        const current = getWorkView(db, project.projectId, input.id);
        if (!current) throw workNotFound(input.id);
        if (current.version !== input.expectedVersion) {
          throw versionConflict(current, input.expectedVersion);
        }

        let status = current.status;
        let resolution = current.resolution;
        if (input.status !== undefined) {
          if (input.status === "review" || input.status === "done") {
            throw invalidTransition(
              current.status,
              input.status,
              `工作狀態 ${input.status} 只能由審查或結案工具設定。`,
              "改用 work_review 或 work_complete。",
            );
          }
          if (input.status !== current.status) {
            if (!canTransition(current.status, input.status)) {
              throw invalidTransition(
                current.status,
                input.status,
                `工作狀態不能從 ${current.status} 轉成 ${input.status}。`,
                "改用允許的目標狀態。",
              );
            }
          }
          status = input.status;
        }
        if (status === "cancelled") resolution = "abandoned";
        else if (status !== "done") resolution = null;

        const title = input.title === undefined ? current.title : normalizeTitle(input.title);
        const objective =
          input.objective === undefined ? current.objective : normalizeObjective(input.objective);
        const nonGoals =
          input.nonGoals === undefined
            ? current.nonGoals
            : normalizeStrings(input.nonGoals, "nonGoals");
        const contextRefs =
          input.contextRefs === undefined
            ? current.contextRefs
            : normalizeStrings(input.contextRefs, "contextRefs");
        const scopePaths =
          input.scopePaths === undefined
            ? current.scopePaths
            : normalizeStrings(input.scopePaths, "scopePaths", { projectPaths: true });
        const acceptance =
          input.acceptance === undefined
            ? current.acceptance
            : normalizeStrings(input.acceptance, "acceptance");
        const labels =
          input.labels === undefined ? current.labels : normalizeStrings(input.labels, "labels");
        const owner = input.owner === undefined ? current.owner : normalizeOwner(input.owner, actor);
        const priority = input.priority ?? current.priority;
        const risk = input.risk === undefined ? current.risk : input.risk;

        let parentId = current.parentId;
        if (input.parentId !== undefined) {
          parentId = input.parentId;
          if (parentId !== null) {
            if (parentId === input.id) {
              throw validationError("工作不能把自己設成上層。", { field: "parentId" });
            }
            assertParent(db, project.projectId, parentId);
          }
        }
        if (current.kind === "plan" && input.parentId !== undefined && input.parentId !== null) {
          throw validationError("計畫（plan）不能有 parentId。", { field: "parentId" });
        }

        const existing = new Set(current.dependsOn);
        const requestedRemovals = new Set(
          normalizeStrings(input.removeDependsOn ?? [], "removeDependsOn"),
        );
        const requestedAdds = normalizeStrings(input.addDependsOn ?? [], "addDependsOn");
        const finalDependsOn = new Set(existing);
        for (const dependency of requestedRemovals) finalDependsOn.delete(dependency);
        for (const dependency of requestedAdds) finalDependsOn.add(dependency);

        const removedEdges = [...existing].filter((dependency) => !finalDependsOn.has(dependency));
        const newEdges = [...finalDependsOn].filter((dependency) => !existing.has(dependency));

        assertDependenciesExist(db, project.projectId, newEdges);
        const graph = loadDependencyGraph(db, project.projectId);
        if (removedEdges.length > 0) {
          const currentEdgeList = graph.get(input.id) ?? [];
          graph.set(
            input.id,
            currentEdgeList.filter((entry) => !removedEdges.includes(entry)),
          );
        }
        assertNoDependencyCycle(graph, input.id, newEdges);
        for (const dependency of removedEdges) {
          db.query("DELETE FROM work_dependencies WHERE work_id = ? AND depends_on_work_id = ?").run(
            input.id,
            dependency,
          );
        }
        for (const dependency of newEdges) {
          db.query(
            "INSERT INTO work_dependencies (work_id, depends_on_work_id, created_at) VALUES (?, ?, ?)",
          ).run(input.id, dependency, nowIso());
        }

        const changedFields: string[] = [];
        if (input.title !== undefined) changedFields.push("title");
        if (input.objective !== undefined) changedFields.push("objective");
        if (input.nonGoals !== undefined) changedFields.push("nonGoals");
        if (input.contextRefs !== undefined) changedFields.push("contextRefs");
        if (input.scopePaths !== undefined) changedFields.push("scopePaths");
        if (input.acceptance !== undefined) changedFields.push("acceptance");
        if (input.status !== undefined && input.status !== current.status) changedFields.push("status");
        if (input.owner !== undefined) changedFields.push("owner");
        if (input.priority !== undefined) changedFields.push("priority");
        if (input.risk !== undefined) changedFields.push("risk");
        if (input.labels !== undefined) changedFields.push("labels");
        if (input.parentId !== undefined) changedFields.push("parentId");
        if (input.addDependsOn !== undefined) changedFields.push("dependsOn");
        if (input.removeDependsOn !== undefined) changedFields.push("dependsOn");

        const now = nowIso();
        const outcome = updateVersionedRow(db, {
          table: "work_items",
          idColumn: "work_id",
          id: input.id,
          expectedVersion: input.expectedVersion,
          values: {
            title,
            objective,
            non_goals: JSON.stringify(nonGoals),
            context_refs: JSON.stringify(contextRefs),
            scope_paths: JSON.stringify(scopePaths),
            acceptance: JSON.stringify(acceptance),
            status,
            resolution,
            owner,
            priority,
            risk,
            plan_id: parentId,
            updated_by: actor.name,
            updated_by_model: actor.model,
          },
          updatedAtColumn: "updated_at",
          updatedAt: now,
        });
        if (!outcome.updated) {
          const latest = getWorkView(db, project.projectId, input.id);
          if (!latest) throw workNotFound(input.id);
          throw versionConflict(latest, input.expectedVersion);
        }

        writeLabels(db, input.id, labels, now);

        if (input.status !== undefined && input.status !== current.status) {
          appendEvent(db, {
            projectId: project.projectId,
            kind: "status_changed",
            actor,
            workId: input.id,
            fromStatus: current.status,
            toStatus: status,
            resolution,
            summary: `狀態從 ${current.status} 轉成 ${status}`,
            now,
          });
        }

        const evidenceItems = input.evidence ?? [];
        const evidence = insertEvidence(db, project.projectId, actor, input.id, evidenceItems, now);

        if (changedFields.length > 0) {
          appendEvent(db, {
            projectId: project.projectId,
            kind: "note",
            actor,
            workId: input.id,
            summary: `更新欄位：${changedFields.join("、")}`,
            details: { fields: changedFields, version: outcome.currentVersion },
            now,
          });
        }

        const work = getWorkView(db, project.projectId, input.id);
        if (!work) throw workNotFound(input.id);
        return ok("工作已更新。", { work, evidence });
      }),
  );
}
