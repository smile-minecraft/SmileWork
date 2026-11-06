import {
  compareCodePoints,
  escapeJsonPointer,
  sha256Text,
  uniqueSorted,
} from "./canonical.ts";
import { ExportV3Error } from "./errors.ts";
import {
  asNonEmptyString,
  asRecord,
  asString,
  type JsonLineEntry,
  type LegacyEntry,
  type SourceData,
} from "./source.ts";
import { mapLegacyStatus } from "./status.ts";
import type {
  EventRecord,
  KnowledgeOutput,
  KnowledgeRecord,
  KnowledgeType,
  Layer,
  Manifest,
  MappingRecord,
  PackageBuild,
  RawOutput,
  Resolution,
  SignalRecord,
  SourceRoot,
  WorkAcceptanceResultItem,
  WorkAcceptanceResults,
  WorkRecord,
  WorkReview,
  WorkStatus,
} from "./types.ts";

const KNOWLEDGE_TYPES: ReadonlySet<string> = new Set([
  "decision",
  "reference",
  "lesson",
  "pitfall",
  "preference",
  "document",
]);

const RISK_VALUES: ReadonlySet<string> = new Set(["low", "medium", "high"]);

const HISTORY_TRANSITION = /^[(（]?([A-Z][A-Z0-9_]*)[)）]?\s*(?:→|->)\s*([A-Z][A-Z0-9_]*)$/;

const HISTORY_REVIEW = /^([A-Z][A-Z0-9_]*)\s*[（(]審查[)）]$/;

const SIGNAL_KINDS: Readonly<Record<string, { code: string; message: string }>> = {
  note: { code: "LEGACY_NOTE", message: "舊版記憶筆記" },
  "note-consumed": { code: "LEGACY_NOTE_CONSUMED", message: "舊版記憶筆記已採用" },
  "note-dismissed": { code: "LEGACY_NOTE_DISMISSED", message: "舊版記憶筆記已忽略" },
};

function layerRank(layer: Layer): number {
  return layer === "project" ? 0 : 1;
}

function layerSourceRoot(layer: Layer): SourceRoot {
  return layer === "project" ? "raw/project" : "raw/global";
}

function packagePath(layer: Layer, relativePath: string): string {
  return `${layerSourceRoot(layer)}/${relativePath}`;
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function boundedNote(value: string): string {
  return value.length <= 2000 ? value : `${value.slice(0, 1999)}…`;
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") result.push(item);
  }
  return result;
}

function orderedUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeTitle(record: Record<string, unknown>, workId: string): string {
  const title = asNonEmptyString(record.title);
  if (title !== undefined) return title;
  return workId;
}

function normalizePriority(
  value: unknown,
  workId: string,
  warnings: SourceData["warnings"],
): string {
  const priority = asNonEmptyString(value);
  if (priority !== undefined && priority.length <= 32) return priority;
  if (priority !== undefined) warnings.add(`LEGACY_PRIORITY_FALLBACK: ${workId}`);
  return "medium";
}

const PLACEHOLDER_OWNERS = new Set(["—", "–", "-"]);

function normalizeOwner(
  value: unknown,
  workId: string,
  warnings: SourceData["warnings"],
): string {
  const owner = asNonEmptyString(value);
  if (owner === undefined) return "unknown";
  if (PLACEHOLDER_OWNERS.has(owner.trim())) {
    warnings.add(`LEGACY_OWNER_FALLBACK: ${workId}`);
    return "unknown";
  }
  return owner;
}

function allocateWorkId(
  original: string,
  kind: "task" | "plan",
  used: Set<string>,
): string {
  let candidate = original;
  if (candidate === "" || candidate.length > 256) {
    candidate = `${kind}-${sha256Text(original).slice(0, 24)}`;
  }
  if (used.has(candidate)) {
    const base = `${kind}:${candidate}`;
    candidate = base.length > 256 ? `${kind}:${sha256Text(original).slice(0, 24)}` : base;
    let suffix = 2;
    while (used.has(candidate)) {
      const next = `${candidate}:${suffix}`;
      candidate = next.length > 256 ? `${kind}:${sha256Text(original + suffix).slice(0, 24)}` : next;
      suffix += 1;
    }
  }
  used.add(candidate);
  return candidate;
}

function normalizeReview(
  value: unknown,
  workId: string,
  warnings: SourceData["warnings"],
): WorkReview | undefined {
  const review = asRecord(value);
  if (review === undefined) {
    if (value !== undefined) warnings.add(`LEGACY_REVIEW_INCOMPLETE: ${workId}`);
    return undefined;
  }
  const verdict = asString(review.verdict);
  const reviewer = asNonEmptyString(review.reviewer);
  if (
    (verdict !== "approve" && verdict !== "concerns" && verdict !== "reject") ||
    reviewer === undefined
  ) {
    warnings.add(`LEGACY_REVIEW_INCOMPLETE: ${workId}`);
    return undefined;
  }
  const result: WorkReview = { verdict, reviewer };
  const note = asString(review.note);
  if (note !== undefined && note !== "") {
    if (note.length <= 4000) {
      result.note = note;
    } else {
      warnings.add(`LEGACY_REVIEW_NOTE_TOO_LONG: ${workId}`);
    }
  }
  if (typeof review.reworkedAfterReview === "boolean") {
    result.reworkedAfterReview = review.reworkedAfterReview;
  }
  return result;
}

function normalizeAcceptanceResults(
  value: unknown,
  acceptance: readonly string[] | undefined,
  workId: string,
  warnings: SourceData["warnings"],
): WorkAcceptanceResults | undefined {
  const results = asRecord(value);
  if (results === undefined) {
    if (value !== undefined) warnings.add(`LEGACY_ACCEPTANCE_MISMATCH: ${workId}`);
    return undefined;
  }
  const recordedBy = asNonEmptyString(results.recordedBy);
  const rawItems = results.items;
  if (recordedBy === undefined || !Array.isArray(rawItems) || rawItems.length === 0) {
    warnings.add(`LEGACY_ACCEPTANCE_MISMATCH: ${workId}`);
    return undefined;
  }
  const items: WorkAcceptanceResultItem[] = [];
  for (const rawItem of rawItems) {
    const item = asRecord(rawItem);
    const criterion = asNonEmptyString(item?.criterion);
    if (item === undefined || criterion === undefined || typeof item.met !== "boolean") {
      warnings.add(`LEGACY_ACCEPTANCE_MISMATCH: ${workId}`);
      return undefined;
    }
    const normalized: WorkAcceptanceResultItem = { criterion, met: item.met };
    if (criterion.length > 1000) {
      warnings.add(`LEGACY_ACCEPTANCE_MISMATCH: ${workId}`);
      return undefined;
    }
    const evidence = asString(item.evidence);
    if (evidence !== undefined && evidence !== "") {
      if (evidence.length <= 4000) {
        normalized.evidence = evidence;
      } else {
        warnings.add(`LEGACY_ACCEPTANCE_EVIDENCE_TOO_LONG: ${workId}`);
      }
    }
    items.push(normalized);
  }
  if (
    acceptance === undefined ||
    acceptance.length !== items.length ||
    items.some((item, index) => item.criterion !== acceptance[index])
  ) {
    warnings.add(`LEGACY_ACCEPTANCE_MISMATCH: ${workId}`);
    return undefined;
  }
  return { recordedBy, items };
}

interface WorkCandidate {
  entry: LegacyEntry;
  workId: string;
  status: WorkStatus;
  resolution?: Resolution;
}

interface SkippedWork {
  kind: "task" | "plan";
  key: string;
  state: string;
}

interface TombstoneCandidate {
  taskId: string;
  planKey: string;
  planWorkId?: string;
  workId: string;
  status: WorkStatus;
  resolution?: Resolution;
}

interface UnresolvedDependency {
  taskKey: string;
  workId: string;
  dependencyId: string;
}

interface WorkAllocation {
  tasks: WorkCandidate[];
  plans: WorkCandidate[];
  tombstones: TombstoneCandidate[];
  taskIdToWorkId: Map<string, string>;
  planIdToWorkId: Map<string, string>;
  skipped: SkippedWork[];
  unresolvedDependencies: UnresolvedDependency[];
}

function allocateWork(source: SourceData): WorkAllocation {
  const usedWorkIds = new Set<string>();
  const taskIdToWorkId = new Map<string, string>();
  const planIdToWorkId = new Map<string, string>();
  const tasks: WorkCandidate[] = [];
  const plans: WorkCandidate[] = [];
  const tombstones: TombstoneCandidate[] = [];
  const skipped: SkippedWork[] = [];
  const unresolvedDependencies: UnresolvedDependency[] = [];
  const tombstoneTaskIds = new Set<string>();

  for (const entry of source.tasks) {
    const state = asString(entry.record.state) ?? "";
    const mapped = mapLegacyStatus(state);
    if (mapped === undefined) {
      source.warnings.add(`UNMAPPED_STATUS: ${entry.key} (${state})`);
      skipped.push({ kind: "task", key: entry.key, state });
      continue;
    }
    const workId = allocateWorkId(entry.key, "task", usedWorkIds);
    taskIdToWorkId.set(entry.key, workId);
    tasks.push({ entry, workId, status: mapped.status, ...(mapped.resolution === undefined ? {} : { resolution: mapped.resolution }) });
  }

  for (const entry of source.plans) {
    const state = asString(entry.record.state) ?? "";
    const mapped = mapLegacyStatus(state);
    if (mapped === undefined) {
      source.warnings.add(`UNMAPPED_STATUS: ${entry.key} (${state})`);
      skipped.push({ kind: "plan", key: entry.key, state });
      continue;
    }
    const workId = allocateWorkId(entry.key, "plan", usedWorkIds);
    planIdToWorkId.set(entry.key, workId);
    plans.push({ entry, workId, status: mapped.status, ...(mapped.resolution === undefined ? {} : { resolution: mapped.resolution }) });
  }

  // 已被 prune 的 task 只剩 plan 的 completionTombstones 這個證據。
  // 轉成最小 work 後，其他 task 的 dependsOn 才有東西可以指向。
  const plansByKey = [...source.plans].sort((left, right) => compareCodePoints(left.key, right.key));
  for (const entry of plansByKey) {
    const tombstonesRecord = asRecord(entry.record.completionTombstones);
    if (tombstonesRecord === undefined) continue;
    const planWorkId = planIdToWorkId.get(entry.key);
    for (const taskId of Object.keys(tombstonesRecord).sort(compareCodePoints)) {
      const tombstone = asRecord(tombstonesRecord[taskId]);
      if (tombstone === undefined) {
        source.warnings.add(`INVALID_TOMBSTONE: ${entry.key}.${taskId}`);
        continue;
      }
      // 真正的 task 還在 registry 裡時，以 registry 為準，不重複建立。
      if (taskIdToWorkId.has(taskId)) continue;
      if (tombstoneTaskIds.has(taskId)) {
        source.warnings.add(`DUPLICATE_TOMBSTONE: ${taskId}`);
        continue;
      }
      const state = asString(tombstone.state) ?? "";
      const mapped = mapLegacyStatus(state);
      if (mapped === undefined) {
        source.warnings.add(`UNMAPPED_TOMBSTONE_STATUS: ${entry.key}.${taskId} (${state})`);
        continue;
      }
      const workId = allocateWorkId(taskId, "task", usedWorkIds);
      taskIdToWorkId.set(taskId, workId);
      tombstoneTaskIds.add(taskId);
      tombstones.push({
        taskId,
        planKey: entry.key,
        ...(planWorkId === undefined ? {} : { planWorkId }),
        workId,
        status: mapped.status,
        ...(mapped.resolution === undefined ? {} : { resolution: mapped.resolution }),
      });
    }
  }

  return {
    tasks,
    plans,
    tombstones,
    taskIdToWorkId,
    planIdToWorkId,
    skipped,
    unresolvedDependencies,
  };
}

function buildWorkRecords(
  source: SourceData,
  allocation: WorkAllocation,
): { records: WorkRecord[]; mapping: MappingRecord[] } {
  const records: WorkRecord[] = [];
  const mapping: MappingRecord[] = [];
  const usedWorkSourceIds = new Set<string>();

  const addMapping = (
    kind: "task" | "plan",
    entry: LegacyEntry,
    workId: string,
  ): void => {
    let sourceId = entry.key;
    if (usedWorkSourceIds.has(sourceId)) sourceId = `${kind}:${entry.key}`;
    usedWorkSourceIds.add(sourceId);
    mapping.push({
      entity: "work",
      layer: "project",
      sourceRoot: "raw/project",
      sourceId,
      sourceRecord: jsonPointer(kind === "task" ? ["tasks", entry.key] : ["plans", entry.key]),
      targetId: workId,
      sourceRef: packagePath("project", kind === "task" ? "tasks.json" : "plans.json"),
      ...(sourceId === entry.key ? {} : { note: boundedNote(`舊識別碼：${entry.key}`) }),
    });
  };

  for (const candidate of allocation.tasks) {
    const { entry, workId, status, resolution } = candidate;
    const record = entry.record;
    const title = normalizeTitle(record, workId);
    if (asNonEmptyString(record.title) === undefined) {
      source.warnings.add(`LEGACY_TITLE_FALLBACK: ${workId}`);
    }
    const work: WorkRecord = {
      workId,
      kind: "task",
      title,
      status,
      owner: normalizeOwner(record.owner, workId, source.warnings),
      priority: normalizePriority(record.priority, workId, source.warnings),
    };
    if (resolution !== undefined) work.resolution = resolution;

    const rawPlanId = asNonEmptyString(record.planId);
    if (rawPlanId !== undefined) {
      const mappedPlanId = allocation.planIdToWorkId.get(rawPlanId);
      if (mappedPlanId === undefined) {
        source.warnings.add(`MISSING_PLAN_REFERENCE: ${entry.key} -> ${rawPlanId}`);
      } else {
        work.planId = mappedPlanId;
      }
    }

    const resolvedDependencies: string[] = [];
    for (const dependencyId of nonEmptyStrings(record.dependsOn)) {
      const mappedDependency = allocation.taskIdToWorkId.get(dependencyId);
      if (mappedDependency === undefined) {
        source.warnings.add(`UNRESOLVED_DEPENDENCY: ${entry.key} -> ${dependencyId}`);
        allocation.unresolvedDependencies.push({ taskKey: entry.key, workId, dependencyId });
        continue;
      }
      resolvedDependencies.push(mappedDependency);
    }
    const dependsOn = uniqueSorted(orderedUnique(resolvedDependencies));
    if (dependsOn.length > 0) work.dependsOn = dependsOn;

    const rawAcceptance = orderedUnique(nonEmptyStrings(record.acceptanceCriteria));
    const acceptance = rawAcceptance.filter((criterion) => criterion.length <= 1000);
    if (acceptance.length !== rawAcceptance.length) {
      source.warnings.add(`LEGACY_ACCEPTANCE_TOO_LONG: ${workId}`);
    }
    if (acceptance.length > 0) work.acceptance = acceptance;

    const risk = asString(record.risk);
    if (risk !== undefined) {
      if (RISK_VALUES.has(risk)) {
        work.risk = risk as "low" | "medium" | "high";
      } else {
        source.warnings.add(`UNMAPPED_RISK_VALUE: ${entry.key} (${risk})`);
      }
    }

    const review = normalizeReview(record.review, workId, source.warnings);
    if (review !== undefined) work.review = review;

    const acceptanceResults = normalizeAcceptanceResults(
      record.acceptanceResults,
      work.acceptance,
      workId,
      source.warnings,
    );
    if (acceptanceResults !== undefined) work.acceptanceResults = acceptanceResults;

    records.push(work);
    addMapping("task", entry, workId);
  }

  for (const candidate of allocation.plans) {
    const { entry, workId, status, resolution } = candidate;
    const record = entry.record;
    const title = normalizeTitle(record, workId);
    if (asNonEmptyString(record.title) === undefined) {
      source.warnings.add(`LEGACY_TITLE_FALLBACK: ${workId}`);
    }
    const work: WorkRecord = {
      workId,
      kind: "plan",
      title,
      status,
      owner: normalizeOwner(record.owner, workId, source.warnings),
      priority: normalizePriority(record.priority, workId, source.warnings),
    };
    if (resolution !== undefined) work.resolution = resolution;
    records.push(work);
    addMapping("plan", entry, workId);
  }

  for (const candidate of allocation.tombstones) {
    const work: WorkRecord = {
      workId: candidate.workId,
      kind: "task",
      title: candidate.workId,
      status: candidate.status,
      owner: "unknown",
      priority: "medium",
    };
    if (candidate.resolution !== undefined) work.resolution = candidate.resolution;
    if (candidate.planWorkId !== undefined) work.planId = candidate.planWorkId;
    source.warnings.add(`LEGACY_TITLE_FALLBACK: ${candidate.workId}`);
    records.push(work);

    let sourceId = candidate.taskId;
    if (usedWorkSourceIds.has(sourceId)) sourceId = `tombstone:${candidate.taskId}`;
    usedWorkSourceIds.add(sourceId);
    mapping.push({
      entity: "work",
      layer: "project",
      sourceRoot: "raw/project",
      sourceId,
      sourceRecord: jsonPointer([
        "plans",
        candidate.planKey,
        "completionTombstones",
        candidate.taskId,
      ]),
      targetId: candidate.workId,
      sourceRef: packagePath("project", "plans.json"),
      note: boundedNote(
        sourceId === candidate.taskId
          ? "由 completionTombstones 重建的最小工作記錄"
          : `由 completionTombstones 重建的最小工作記錄；舊識別碼：${candidate.taskId}`,
      ),
    });
  }

  records.sort((left, right) => compareCodePoints(left.workId, right.workId));
  return { records, mapping };
}

interface EventCandidate {
  at: string;
  order: number;
  record: Omit<EventRecord, "eventId" | "sequence">;
  mapping: MappingRecord;
}

interface ParsedHistoryLine {
  at: string;
  action: string;
  actor: string;
  description: string;
}

function parseHistoryLine(line: string): ParsedHistoryLine | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  const parts = body.split("|").map((part) => part.trim());
  if (parts.length < 3) return undefined;
  const actor = parts[2] ?? "";
  return {
    at: parts[0] ?? "",
    action: parts[1] ?? "",
    actor: actor === "—" || actor === "-" ? "" : actor,
    description: parts.slice(3).join(" | ").trim(),
  };
}

function historyEvent(
  workId: string,
  parsed: ParsedHistoryLine,
  source: SourceData,
): Omit<EventRecord, "eventId" | "sequence"> {
  const action = parsed.action;
  const actor = parsed.actor === "" ? "unknown" : parsed.actor;
  const transition = HISTORY_TRANSITION.exec(action);
  if (transition !== null) {
    const from = transition[1]!;
    const to = transition[2]!;
    const mappedFrom = mapLegacyStatus(from);
    const mappedTo = mapLegacyStatus(to);
    if (mappedFrom !== undefined && mappedTo !== undefined) {
      const created = from === "NEW" && to === "NEW";
      const details: Record<string, unknown> = { legacy: true, source: "history" };
      if (from !== mappedFrom.status) details.legacyFromStatus = from;
      if (to !== mappedTo.status) details.legacyToStatus = to;
      const summary = parsed.description === ""
        ? `${from} → ${to}`
        : parsed.description;
      const record: Omit<EventRecord, "eventId" | "sequence"> = {
        kind: created ? "created" : "status_changed",
        actor,
        workId,
        fromStatus: mappedFrom.status,
        toStatus: mappedTo.status,
        summary,
      };
      if (mappedTo.resolution !== undefined) record.resolution = mappedTo.resolution;
      record.details = details;
      return record;
    }
    source.warnings.add(`UNMAPPED_EVENT_STATUS: ${workId} (${action})`);
    return {
      kind: "note",
      actor,
      workId,
      summary: parsed.description === "" ? action : `${action}：${parsed.description}`,
      details: { legacy: true, source: "history", legacyAction: action },
    };
  }

  const review = HISTORY_REVIEW.exec(action);
  if (review !== null) {
    return {
      kind: "reviewed",
      actor,
      workId,
      summary: parsed.description === "" ? "審查" : parsed.description,
      details: { legacy: true, source: "history", legacyAction: action },
    };
  }

  const summary = parsed.description === ""
    ? action || "舊版歷程"
    : action === ""
      ? parsed.description
      : `${action}：${parsed.description}`;
  return {
    kind: "note",
    actor,
    workId,
    summary,
    details: { legacy: true, source: "history", ...(action === "" ? {} : { legacyAction: action }) },
  };
}

function collectHistoryEvents(
  source: SourceData,
  allocation: WorkAllocation,
  candidates: EventCandidate[],
  nextOrder: () => number,
): void {
  for (const candidate of allocation.tasks) {
    const { entry, workId } = candidate;
    const history = entry.record.history;
    if (history !== undefined && !Array.isArray(history)) {
      source.warnings.add(`INVALID_HISTORY: ${entry.key}`);
      continue;
    }
    for (const [index, line] of (history ?? []).entries()) {
      if (typeof line !== "string") {
        source.warnings.add(`INVALID_HISTORY_LINE: ${entry.key} ${index}`);
        continue;
      }
      const parsed = parseHistoryLine(line);
      if (parsed === undefined) {
        source.warnings.add(`INVALID_HISTORY_LINE: ${entry.key} ${index}`);
        continue;
      }
      candidates.push({
        at: parsed.at,
        order: nextOrder(),
        record: historyEvent(workId, parsed, source),
        mapping: {
          entity: "event",
          layer: "project",
          sourceRoot: "raw/project",
          sourceId: `history:task:${entry.key}:${index}`,
          sourceRecord: jsonPointer(["tasks", entry.key, "history", String(index)]),
          targetId: "",
          sourceRef: packagePath("project", "tasks.json"),
        },
      });
    }
  }

  for (const candidate of allocation.plans) {
    const { entry, workId } = candidate;
    const history = entry.record.history;
    if (history !== undefined && !Array.isArray(history)) {
      source.warnings.add(`INVALID_HISTORY: ${entry.key}`);
      continue;
    }
    for (const [index, line] of (history ?? []).entries()) {
      if (typeof line !== "string") {
        source.warnings.add(`INVALID_HISTORY_LINE: ${entry.key} ${index}`);
        continue;
      }
      const parsed = parseHistoryLine(line);
      if (parsed === undefined) {
        source.warnings.add(`INVALID_HISTORY_LINE: ${entry.key} ${index}`);
        continue;
      }
      candidates.push({
        at: parsed.at,
        order: nextOrder(),
        record: historyEvent(workId, parsed, source),
        mapping: {
          entity: "event",
          layer: "project",
          sourceRoot: "raw/project",
          sourceId: `history:plan:${entry.key}:${index}`,
          sourceRecord: jsonPointer(["plans", entry.key, "history", String(index)]),
          targetId: "",
          sourceRef: packagePath("project", "plans.json"),
        },
      });
    }
  }
}

function auditEvent(
  entry: JsonLineEntry,
  allocation: WorkAllocation,
  source: SourceData,
): Omit<EventRecord, "eventId" | "sequence"> {
  const record = entry.record;
  const event = asString(record.event) ?? "";
  const actor = asNonEmptyString(record.actor) ??
    asNonEmptyString(record.reviewer) ??
    "unknown";
  const legacyTaskId = asString(record.taskId);
  const workId = legacyTaskId === undefined
    ? undefined
    : allocation.taskIdToWorkId.get(legacyTaskId);
  const details: Record<string, unknown> = { legacy: true, source: "audit", legacyEvent: event };
  if (legacyTaskId !== undefined && workId === undefined) details.legacyTaskId = legacyTaskId;
  const base = {
    actor,
    ...(workId === undefined ? {} : { workId }),
  };

  switch (event) {
    case "review": {
      const verdict = asString(record.verdict);
      if (verdict !== "approve" && verdict !== "concerns" && verdict !== "reject") {
        source.warnings.add(`UNMAPPED_REVIEW_VERDICT: ${entry.relativePath} 第 ${entry.lineIndex + 1} 行`);
        return { ...base, kind: "note", summary: "舊版審查紀錄", details };
      }
      details.verdict = verdict;
      const reviewer = asNonEmptyString(record.reviewer);
      if (reviewer !== undefined) details.reviewer = reviewer;
      const note = asString(record.note);
      if (note !== undefined && note !== "") details.note = note;
      return { ...base, kind: "reviewed", summary: `審查結論：${verdict}`, details };
    }
    case "risk-declared": {
      const phase = asString(record.phase);
      if (phase !== undefined) details.phase = phase;
      const risk = asString(record.risk);
      if (risk !== undefined) details.risk = risk;
      return { ...base, kind: "note", summary: "申報高風險", details };
    }
    case "risk-downgrade-blocked": {
      const requestedRisk = asString(record.requestedRisk);
      if (requestedRisk !== undefined) details.requestedRisk = requestedRisk;
      return { ...base, kind: "note", summary: "阻擋高風險降級", details };
    }
    case "terminal": {
      const finalState = asString(record.finalState) ?? "";
      const mapped = mapLegacyStatus(finalState);
      if (mapped === undefined) {
        source.warnings.add(`UNMAPPED_STATUS: ${legacyTaskId ?? "audit"} (${finalState})`);
        details.finalState = finalState;
        return { ...base, kind: "note", summary: "舊版終態紀錄", details };
      }
      const result: Omit<EventRecord, "eventId" | "sequence"> = {
        ...base,
        kind: "status_changed",
        toStatus: mapped.status,
        summary: `進入終態：${finalState}`,
        details,
      };
      if (mapped.resolution !== undefined) result.resolution = mapped.resolution;
      return result;
    }
    default:
      source.warnings.add(`UNMAPPED_AUDIT_EVENT: ${event}`);
      return { ...base, kind: "note", summary: event === "" ? "舊版稽核紀錄" : event, details };
  }
}

function buildEvents(
  source: SourceData,
  allocation: WorkAllocation,
): { records: EventRecord[]; mapping: MappingRecord[] } {
  const candidates: EventCandidate[] = [];
  let order = 0;
  const nextOrder = (): number => {
    order += 1;
    return order;
  };
  collectHistoryEvents(source, allocation, candidates, nextOrder);

  for (const entry of source.audit) {
    candidates.push({
      at: asString(entry.record.at) ?? "",
      order: nextOrder(),
      record: auditEvent(entry, allocation, source),
      mapping: {
        entity: "event",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: `audit:${entry.lineIndex}`,
        sourceRecord: `/${entry.lineIndex}`,
        targetId: "",
        sourceRef: packagePath("project", "audit.jsonl"),
      },
    });
  }

  candidates.sort((left, right) => {
    const atOrder = compareCodePoints(left.at, right.at);
    return atOrder !== 0 ? atOrder : left.order - right.order;
  });

  const records: EventRecord[] = [];
  const mapping: MappingRecord[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const sequence = index + 1;
    const eventId = `e-${pad4(sequence)}`;
    records.push({ eventId, sequence, ...candidate.record });
    mapping.push({ ...candidate.mapping, targetId: eventId });
  }
  return { records, mapping };
}

function buildSignals(source: SourceData, allocation: WorkAllocation): {
  records: SignalRecord[];
  mapping: MappingRecord[];
} {
  const records: SignalRecord[] = [];
  const mapping: MappingRecord[] = [];

  const skipped = [...allocation.skipped].sort((left, right) => {
    const kindOrder = compareCodePoints(left.kind, right.kind);
    return kindOrder !== 0 ? kindOrder : compareCodePoints(left.key, right.key);
  });
  for (const entry of skipped) {
    const signalId = `s-${pad4(records.length + 1)}`;
    const kindLabel = entry.kind === "task" ? "任務" : "計畫";
    const sourceRef = packagePath("project", entry.kind === "task" ? "tasks.json" : "plans.json");
    records.push({
      signalId,
      severity: "warning",
      code: "UNMAPPED_STATUS",
      message: `${kindLabel} ${entry.key} 的狀態 ${entry.state} 無法對應，已保留在 raw/`,
      details: { legacyStatus: entry.state, workKind: entry.kind },
    });
    mapping.push({
      entity: "signal",
      layer: "project",
      sourceRoot: "raw/project",
      sourceId: `status:${entry.kind}:${entry.key}`,
      sourceRecord: jsonPointer([entry.kind === "task" ? "tasks" : "plans", entry.key]),
      targetId: signalId,
      sourceRef,
    });
  }

  const unresolved = [...allocation.unresolvedDependencies].sort((left, right) => {
    const taskOrder = compareCodePoints(left.taskKey, right.taskKey);
    return taskOrder !== 0
      ? taskOrder
      : compareCodePoints(left.dependencyId, right.dependencyId);
  });
  for (const dependency of unresolved) {
    const signalId = `s-${pad4(records.length + 1)}`;
    records.push({
      signalId,
      severity: "warning",
      code: "UNRESOLVED_DEPENDENCY",
      message: `任務 ${dependency.taskKey} 的依賴 ${dependency.dependencyId} 找不到對應工作，已從 dependsOn 移除`,
      workId: dependency.workId,
      details: { dependencyId: dependency.dependencyId },
    });
    mapping.push({
      entity: "signal",
      layer: "project",
      sourceRoot: "raw/project",
      sourceId: `dependency:${dependency.taskKey}:${dependency.dependencyId}`,
      sourceRecord: jsonPointer(["tasks", dependency.taskKey]),
      targetId: signalId,
      sourceRef: packagePath("project", "tasks.json"),
    });
  }

  const entries = [...source.memoryLogs].sort((left, right) => {
    const layerOrder = layerRank(left.layer) - layerRank(right.layer);
    return layerOrder !== 0 ? layerOrder : left.lineIndex - right.lineIndex;
  });

  for (const entry of entries) {
    const kind = asString(entry.record.kind) ?? "";
    const descriptor = SIGNAL_KINDS[kind];
    if (descriptor === undefined) continue;
    const content = asNonEmptyString(entry.record.content) ??
      asNonEmptyString(entry.record.reason) ??
      descriptor.message;
    const legacyTaskId = asString(entry.record.taskId);
    const workId = legacyTaskId === undefined
      ? undefined
      : allocation.taskIdToWorkId.get(legacyTaskId);
    const details: Record<string, unknown> = { legacyKind: kind };
    const topic = asString(entry.record.topic);
    if (topic !== undefined) details.topic = topic;
    const agent = asString(entry.record.agent);
    if (agent !== undefined) details.agent = agent;
    // noteSeq 只在 consumed／dismissed 這種「指向另一筆筆記」的紀錄上出現；
    // note 自己的 seq 不是另一個筆記的編號。
    if (typeof entry.record.noteSeq === "number") details.noteSeq = entry.record.noteSeq;
    if (legacyTaskId !== undefined && workId === undefined) details.legacyTaskId = legacyTaskId;

    const signalId = `s-${pad4(records.length + 1)}`;
    records.push({
      signalId,
      severity: "info",
      code: descriptor.code,
      message: content,
      ...(workId === undefined ? {} : { workId }),
      details,
    });
    mapping.push({
      entity: "signal",
      layer: entry.layer,
      sourceRoot: layerSourceRoot(entry.layer),
      sourceId: `log:${entry.lineIndex}`,
      sourceRecord: `/${entry.lineIndex}`,
      targetId: signalId,
      sourceRef: packagePath(entry.layer, entry.relativePath),
    });
  }

  return { records, mapping };
}

function sanitizeKnowledgeId(value: string): string {
  let safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-");
  safe = safe.replace(/^[^A-Za-z0-9]+/, "").replace(/-+$/, "");
  if (safe === "") safe = `k-${sha256Text(value).slice(0, 12)}`;
  if (safe.length > 128) safe = `${safe.slice(0, 100)}-${sha256Text(value).slice(0, 12)}`;
  return safe;
}

function allocateKnowledgeId(
  entry: { layer: Layer; stem: string },
  used: Set<string>,
): string {
  let candidate = sanitizeKnowledgeId(entry.stem);
  if (used.has(candidate)) {
    candidate = sanitizeKnowledgeId(`${entry.layer}-${entry.stem}`);
  }
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = sanitizeKnowledgeId(`${entry.layer}-${entry.stem}-${suffix}`);
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeKnowledgeBody(body: string): string {
  return body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/^\n+/, "");
}

function parsePinned(
  value: unknown,
  label: string,
  warnings: SourceData["warnings"],
): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== undefined) warnings.add(`LEGACY_KNOWLEDGE_PINNED_FALLBACK: ${label}`);
  return false;
}

function buildKnowledge(source: SourceData): {
  entries: KnowledgeOutput[];
  mapping: MappingRecord[];
} {
  const entries: KnowledgeOutput[] = [];
  const mapping: MappingRecord[] = [];
  const usedIds = new Set<string>();
  const usedSourceIds = new Map<Layer, Set<string>>();
  const topics = [...source.topics].sort((left, right) => {
    const layerOrder = layerRank(left.layer) - layerRank(right.layer);
    return layerOrder !== 0
      ? layerOrder
      : compareCodePoints(left.relativePath, right.relativePath);
  });

  for (const topic of topics) {
    const label = `${topic.layer}/${topic.relativePath}`;
    const knowledgeId = allocateKnowledgeId(topic, usedIds);
    const rawType = asString(topic.data.type)?.trim() ?? "";
    let type: KnowledgeType;
    if (KNOWLEDGE_TYPES.has(rawType)) {
      type = rawType as KnowledgeType;
    } else {
      type = "reference";
      source.warnings.add(`LEGACY_KNOWLEDGE_TYPE_FALLBACK: ${label} (${rawType})`);
    }
    const rawTitle = asNonEmptyString(topic.data.title);
    if (rawTitle === undefined) source.warnings.add(`LEGACY_KNOWLEDGE_TITLE_FALLBACK: ${label}`);
    const title = rawTitle ?? knowledgeId;
    const description = asString(topic.data.description) ?? "";
    const pinned = parsePinned(topic.data.pinned, label, source.warnings);
    const rawSource = asNonEmptyString(topic.data.source);
    if (rawSource === undefined) source.warnings.add(`LEGACY_KNOWLEDGE_SOURCE_FALLBACK: ${label}`);
    const knowledgeSource = rawSource ?? "unknown";

    const rawTags = topic.data.tags;
    let tags: string[] | undefined;
    if (Array.isArray(rawTags)) {
      const parsed = rawTags.filter((tag): tag is string => typeof tag === "string" && tag !== "");
      if (parsed.length > 0) tags = uniqueSorted(parsed);
    } else if (rawTags !== undefined) {
      source.warnings.add(`LEGACY_KNOWLEDGE_TAGS_INVALID: ${label}`);
    }

    const body = normalizeKnowledgeBody(topic.body);
    const bodyBytes = Buffer.from(body, "utf8");
    const versionPath = `knowledge/files/${knowledgeId}/v1.md`;
    const record: KnowledgeRecord = {
      knowledgeId,
      type,
      layer: topic.layer,
      title,
      description,
      pinned,
      source: knowledgeSource,
      versions: [
        {
          version: 1,
          path: versionPath,
          sha256: sha256Text(body),
          bytes: bodyBytes.byteLength,
        },
      ],
      currentVersion: 1,
    };
    if (tags !== undefined) record.tags = tags;
    entries.push({ record, body });

    let usedSourceIdsForLayer = usedSourceIds.get(topic.layer);
    if (usedSourceIdsForLayer === undefined) {
      usedSourceIdsForLayer = new Set<string>();
      usedSourceIds.set(topic.layer, usedSourceIdsForLayer);
    }
    let sourceId = topic.stem;
    if (usedSourceIdsForLayer.has(sourceId)) sourceId = topic.relativePath;
    usedSourceIdsForLayer.add(sourceId);
    mapping.push({
      entity: "knowledge",
      layer: topic.layer,
      sourceRoot: layerSourceRoot(topic.layer),
      sourceId,
      sourceRecord: "frontmatter",
      targetId: knowledgeId,
      sourceRef: packagePath(topic.layer, topic.safePath),
      ...(sourceId === topic.stem ? {} : { note: boundedNote(`舊識別碼：${topic.stem}`) }),
    });
  }

  const skills = [...source.skills].sort((left, right) => {
    const layerOrder = layerRank(left.layer) - layerRank(right.layer);
    return layerOrder !== 0
      ? layerOrder
      : compareCodePoints(left.relativePath, right.relativePath);
  });
  for (const skill of skills) {
    const knowledgeId = allocateKnowledgeId({ layer: skill.layer, stem: `skill-${skill.name}` }, usedIds);
    const title = asNonEmptyString(skill.data.name) ?? skill.name;
    const description = asString(skill.data.description) ?? "";
    const body = normalizeKnowledgeBody(skill.body);
    const bodyBytes = Buffer.from(body, "utf8");
    const versionPath = `knowledge/files/${knowledgeId}/v1.md`;
    const record: KnowledgeRecord = {
      knowledgeId,
      type: "document",
      layer: skill.layer,
      title,
      description,
      pinned: false,
      source: "skill-draft",
      versions: [
        {
          version: 1,
          path: versionPath,
          sha256: sha256Text(body),
          bytes: bodyBytes.byteLength,
        },
      ],
      currentVersion: 1,
    };
    entries.push({ record, body });
    mapping.push({
      entity: "knowledge",
      layer: skill.layer,
      sourceRoot: layerSourceRoot(skill.layer),
      sourceId: skill.relativePath,
      sourceRecord: "frontmatter",
      targetId: knowledgeId,
      sourceRef: packagePath(skill.layer, skill.safePath),
    });
  }

  entries.sort((left, right) => compareCodePoints(left.record.knowledgeId, right.record.knowledgeId));
  return { entries, mapping };
}

function buildRaw(source: SourceData): { files: RawOutput[]; mapping: MappingRecord[] } {
  const files: RawOutput[] = [];
  const mapping: MappingRecord[] = [];
  for (const file of source.files) {
    const targetId = packagePath(file.layer, file.safePath);
    files.push({
      layer: file.layer,
      sourcePath: file.relativePath,
      safePath: file.safePath,
      absolutePath: file.absolutePath,
      sha256: file.sha256,
    });
    mapping.push({
      entity: "raw",
      layer: file.layer,
      sourceRoot: layerSourceRoot(file.layer),
      sourceId: file.safePath,
      targetId,
      sourceRef: targetId,
      sha256: file.sha256,
      ...(file.safePath === file.relativePath
        ? {}
        : { note: boundedNote(`原始來源路徑：${file.relativePath}`) }),
    });
  }
  return { files, mapping };
}

function jsonPointer(parts: readonly string[]): string {
  return parts.map((part) => `/${escapeJsonPointer(part)}`).join("");
}

function sortMappings(records: MappingRecord[]): MappingRecord[] {
  return records.sort((left, right) => {
    const entity = compareCodePoints(left.entity, right.entity);
    if (entity !== 0) return entity;
    const layer = compareCodePoints(left.layer, right.layer);
    if (layer !== 0) return layer;
    const source = compareCodePoints(left.sourceId, right.sourceId);
    if (source !== 0) return source;
    return compareCodePoints(left.targetId, right.targetId);
  });
}

export interface BuildPackageOptions {
  createdAt: string;
  producerVersion: string;
}

/** 把讀進來的來源資料轉成整包輸出；不碰磁碟。 */
export function buildPackage(source: SourceData, options: BuildPackageOptions): PackageBuild {
  const allocation = allocateWork(source);
  const work = buildWorkRecords(source, allocation);
  const events = buildEvents(source, allocation);
  const signals = buildSignals(source, allocation);
  const knowledge = buildKnowledge(source);
  const raw = buildRaw(source);
  const mapping = sortMappings([
    ...work.mapping,
    ...events.mapping,
    ...signals.mapping,
    ...knowledge.mapping,
    ...raw.mapping,
  ]);

  const projectFiles = raw.files.filter((file) => file.layer === "project").length;
  const globalFiles = raw.files.filter((file) => file.layer === "global").length;
  const layers: Layer[] = source.globalRoot === undefined ? ["project"] : ["project", "global"];

  const manifest: Manifest = {
    format: "smilework-export",
    formatVersion: 1,
    createdAt: options.createdAt,
    producer: { name: "smilework", version: options.producerVersion },
    source: {
      kind: "ultrawork-v3",
      projectId: source.projectId,
      ...(source.registryVersion === undefined
        ? {}
        : { registryVersion: source.registryVersion }),
      layers,
    },
    layout: {
      manifest: { path: "manifest.json" },
      work: { path: "work.jsonl", records: work.records.length },
      events: { path: "events.jsonl", records: events.records.length },
      evidence: { path: "evidence.jsonl", records: 0 },
      signals: { path: "signals.jsonl", records: signals.records.length },
      knowledge: {
        path: "knowledge/",
        entries: knowledge.entries.length,
        files: knowledge.entries.length,
      },
      mapping: { path: "mapping.jsonl", records: mapping.length },
      raw: {
        path: "raw/",
        files: raw.files.length,
        projectFiles,
        globalFiles,
      },
    },
    warnings: source.warnings.all(),
  };

  return {
    manifest,
    work: work.records,
    events: events.records,
    evidence: [],
    signals: signals.records,
    knowledge: knowledge.entries,
    mapping,
    raw: raw.files,
  };
}
