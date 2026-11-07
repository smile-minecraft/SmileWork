import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { compareCodePoints, sha256Bytes, uniqueSorted } from "../../export/v3/canonical.ts";
import type {
  EvidenceRecord,
  EventRecord,
  KnowledgeInput,
  KnowledgeRecord,
  KnowledgeVersionBody,
  Layer,
  Manifest,
  MappingRecord,
  SignalRecord,
  WorkAcceptanceResultItem,
  WorkAcceptanceResults,
  WorkRecord,
  WorkReview,
} from "../../import/types.ts";
import {
  EVIDENCE_KINDS,
  EVENT_KINDS,
  KNOWLEDGE_TYPES,
  RISK_LEVELS,
  SIGNAL_DETAILS_KEY,
  SIGNAL_SEVERITIES,
  WORK_KINDS,
  WORK_RESOLUTIONS,
  WORK_STATUSES,
} from "../../import/types.ts";
import { WarningCollector } from "../../import/warnings.ts";
import { ExportCurrentError } from "./errors.ts";
import type { CurrentPackage, RawOutput } from "./types.ts";

const KNOWLEDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PACKAGE_PATH = /^(?:raw\/(?:project|global)|knowledge)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNAL_CODE = /^[A-Z][A-Z0-9_]*$/;
const TIMESTAMP_KEY = new RegExp(
  "^(createdAt|updatedAt|generatedAt|exportedAt|modifiedAt|created_at|updated_at|generated_at|exported_at|verified_at|verifiedAt|timestamp|exportTime)$",
  "i",
);

/** 內容檔不能有時間戳欄位；details 是自由物件，但要先移除。 */
function stripTimestampKeys(
  value: unknown,
  label: string,
  warnings: WarningCollector,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripTimestampKeys(item, label, warnings));
  }
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (TIMESTAMP_KEY.test(key)) {
      warnings.add(`DATABASE_TIMESTAMP_IN_DETAILS ${label}：${key}`);
      continue;
    }
    result[key] = stripTimestampKeys(child, label, warnings);
  }
  return result;
}

interface WorkRow {
  work_id: string;
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
  acceptance_results: string | null;
}

interface EventRow {
  event_id: string;
  sequence: number;
  kind: string;
  actor: string;
  work_id: string | null;
  from_status: string | null;
  to_status: string | null;
  resolution: string | null;
  summary: string | null;
  details: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  work_id: string;
  kind: string;
  actor: string;
  summary: string;
  command: string | null;
  output: string | null;
  url: string | null;
  path: string | null;
  sha256: string | null;
  details: string | null;
}

interface SignalRow {
  signal_id: string;
  scope: string;
  kind: string;
  content: string;
  status: string;
  work_id: string | null;
  refs: string;
  result_refs: string;
  reason: string | null;
  details: string | null;
  severity: string | null;
  code: string | null;
}

interface KnowledgeRow {
  id: number;
  knowledge_id: string;
  layer: string;
  kind: string;
  type: string;
  title: string;
  description: string;
  pinned: number;
  source: string;
  tags: string;
  status: string;
  current_version: number;
  work_id: string | null;
}

interface VersionRow {
  entry_id: number;
  version: number;
  sha256: string;
  bytes: number;
  snapshot_path: string;
}

interface MappingRow {
  entity: string;
  layer: string;
  source_id: string;
  source_record: string | null;
  target_id: string;
  source_ref: string | null;
  sha256: string | null;
  note: string | null;
}

function safePackagePath(value: string): boolean {
  if (!PACKAGE_PATH.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function parseStringArray(
  value: string,
  label: string,
  warnings: WarningCollector,
): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("不是陣列");
    return parsed.filter((item): item is string => typeof item === "string" && item !== "");
  } catch {
    warnings.add(`DATABASE_JSON_INVALID ${label}`);
    return [];
  }
}

function parseObject(
  value: string | null,
  label: string,
  warnings: WarningCollector,
): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.add(`DATABASE_JSON_INVALID ${label}`);
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    warnings.add(`DATABASE_JSON_INVALID ${label}`);
    return undefined;
  }
}

function normalizeReview(
  value: string | null,
  workId: string,
  warnings: WarningCollector,
): WorkReview | undefined {
  const parsed = parseObject(value, `work_items.review ${workId}`, warnings);
  if (parsed === undefined) return undefined;
  const verdict =
    parsed.verdict === "approve" || parsed.verdict === "concerns" || parsed.verdict === "reject"
      ? parsed.verdict
      : undefined;
  const reviewer = typeof parsed.reviewer === "string" ? parsed.reviewer : undefined;
  if (verdict === undefined || reviewer === undefined || reviewer === "" || reviewer.length > 128) {
    warnings.add(`DATABASE_REVIEW_INVALID ${workId}`);
    return undefined;
  }
  const review: WorkReview = { verdict, reviewer };
  if (typeof parsed.note === "string" && parsed.note !== "") {
    if (parsed.note.length <= 4000) review.note = parsed.note;
    else warnings.add(`DATABASE_REVIEW_NOTE_TOO_LONG ${workId}`);
  }
  if (typeof parsed.reworkedAfterReview === "boolean") {
    review.reworkedAfterReview = parsed.reworkedAfterReview;
  }
  return review;
}

function normalizeAcceptanceResults(
  value: string | null,
  acceptance: readonly string[] | undefined,
  workId: string,
  warnings: WarningCollector,
): WorkAcceptanceResults | undefined {
  const parsed = parseObject(value, `work_items.acceptance_results ${workId}`, warnings);
  if (parsed === undefined) return undefined;
  const recordedBy = typeof parsed.recordedBy === "string" ? parsed.recordedBy : undefined;
  if (recordedBy === undefined || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    warnings.add(`DATABASE_ACCEPTANCE_INVALID ${workId}`);
    return undefined;
  }
  const items: WorkAcceptanceResultItem[] = [];
  for (const rawItem of parsed.items) {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      warnings.add(`DATABASE_ACCEPTANCE_INVALID ${workId}`);
      return undefined;
    }
    const item = rawItem as Record<string, unknown>;
    if (
      typeof item.criterion !== "string" ||
      item.criterion === "" ||
      item.criterion.length > 1000 ||
      typeof item.met !== "boolean"
    ) {
      warnings.add(`DATABASE_ACCEPTANCE_INVALID ${workId}`);
      return undefined;
    }
    const normalized: WorkAcceptanceResultItem = { criterion: item.criterion, met: item.met };
    if (typeof item.evidence === "string" && item.evidence !== "") {
      if (item.evidence.length <= 4000) normalized.evidence = item.evidence;
      else warnings.add(`DATABASE_ACCEPTANCE_EVIDENCE_TOO_LONG ${workId}`);
    } else if (Array.isArray(item.evidenceIds)) {
      const evidence = item.evidenceIds.filter((id): id is string => typeof id === "string");
      if (evidence.length > 0) normalized.evidence = evidence.join(", ").slice(0, 4000);
    }
    items.push(normalized);
  }
  if (
    acceptance === undefined ||
    items.length !== acceptance.length ||
    items.some((item, index) => item.criterion !== acceptance[index])
  ) {
    warnings.add(`DATABASE_ACCEPTANCE_MISMATCH ${workId}`);
    return undefined;
  }
  return { recordedBy, items };
}

function boundedStrings(
  values: readonly string[],
  limit: number,
  label: string,
  workId: string,
  warnings: WarningCollector,
): string[] {
  const filtered = values.filter((value) => value.length <= limit);
  if (filtered.length !== values.length) {
    warnings.add(`DATABASE_WORK_FIELD_TOO_LONG ${workId} ${label}`);
  }
  return filtered;
}

function buildWork(
  db: Database,
  projectId: string,
  warnings: WarningCollector,
): WorkRecord[] {
  const rows = db
    .query<WorkRow, [string]>(
      `SELECT work_id, kind, title, status, resolution, owner, priority, plan_id,
              objective, non_goals, context_refs, scope_paths, acceptance, risk, review,
              acceptance_results
         FROM work_items WHERE project_id = ? ORDER BY work_id`,
    )
    .all(projectId);

  const dependencies = new Map<string, string[]>();
  for (const row of db
    .query<{ work_id: string; depends_on_work_id: string }, [string]>(
      `SELECT work_id, depends_on_work_id FROM work_dependencies
        WHERE work_id IN (SELECT work_id FROM work_items WHERE project_id = ?)
        ORDER BY work_id, depends_on_work_id`,
    )
    .all(projectId)) {
    const list = dependencies.get(row.work_id) ?? [];
    list.push(row.depends_on_work_id);
    dependencies.set(row.work_id, list);
  }

  const work: WorkRecord[] = [];
  for (const row of rows) {
    const kind = oneOf(WORK_KINDS, row.kind);
    const status = oneOf(WORK_STATUSES, row.status);
    if (kind === undefined || status === undefined || row.work_id === "") {
      warnings.add(`DATABASE_WORK_INVALID ${row.work_id}`);
      continue;
    }
    const title = row.title === "" ? row.work_id : row.title;
    if (row.title === "") warnings.add(`DATABASE_WORK_TITLE_FALLBACK ${row.work_id}`);
    const owner = row.owner === "" ? "unknown" : row.owner;
    if (row.owner === "") warnings.add(`DATABASE_WORK_OWNER_FALLBACK ${row.work_id}`);
    const priority = row.priority === "" || row.priority.length > 32 ? "medium" : row.priority;
    if (priority !== row.priority) warnings.add(`DATABASE_WORK_PRIORITY_FALLBACK ${row.work_id}`);
    const record: WorkRecord = {
      workId: row.work_id,
      kind,
      title,
      status,
      owner,
      priority,
    };
    const resolution = oneOf(WORK_RESOLUTIONS, row.resolution);
    if (resolution !== undefined) record.resolution = resolution;
    if (row.plan_id !== null) {
      if (row.plan_id.length <= 256) record.planId = row.plan_id;
      else warnings.add(`DATABASE_WORK_FIELD_TOO_LONG ${row.work_id} planId`);
    }
    const dependsOn = dependencies.get(row.work_id);
    if (dependsOn !== undefined && dependsOn.length > 0) {
      const bounded = boundedStrings(dependsOn, 256, "dependsOn", row.work_id, warnings);
      if (bounded.length > 0) record.dependsOn = uniqueSorted(bounded);
    }

    if (row.objective !== null && row.objective !== "") {
      if (row.objective.length <= 2000) record.objective = row.objective;
      else warnings.add(`DATABASE_OBJECTIVE_TOO_LONG ${row.work_id}`);
    }
    const nonGoals = boundedStrings(
      parseStringArray(row.non_goals, `work_items.non_goals ${row.work_id}`, warnings),
      500,
      "nonGoals",
      row.work_id,
      warnings,
    );
    if (nonGoals.length > 0) record.nonGoals = uniqueSorted(nonGoals);
    const contextRefs = boundedStrings(
      parseStringArray(row.context_refs, `work_items.context_refs ${row.work_id}`, warnings),
      512,
      "contextRefs",
      row.work_id,
      warnings,
    );
    if (contextRefs.length > 0) record.contextRefs = uniqueSorted(contextRefs);
    const scopePaths = boundedStrings(
      parseStringArray(row.scope_paths, `work_items.scope_paths ${row.work_id}`, warnings),
      512,
      "scopePaths",
      row.work_id,
      warnings,
    );
    if (scopePaths.length > 0) record.scopePaths = uniqueSorted(scopePaths);
    const acceptance = boundedStrings(
      parseStringArray(row.acceptance, `work_items.acceptance ${row.work_id}`, warnings),
      1000,
      "acceptance",
      row.work_id,
      warnings,
    );
    if (acceptance.length > 0) record.acceptance = [...new Set(acceptance)];

    const risk = oneOf(RISK_LEVELS, row.risk);
    if (risk !== undefined) record.risk = risk;
    else if (row.risk !== null) warnings.add(`DATABASE_RISK_INVALID ${row.work_id}`);

    const review = normalizeReview(row.review, row.work_id, warnings);
    if (review !== undefined) record.review = review;
    const acceptanceResults = normalizeAcceptanceResults(
      row.acceptance_results,
      record.acceptance,
      row.work_id,
      warnings,
    );
    if (acceptanceResults !== undefined) record.acceptanceResults = acceptanceResults;

    work.push(record);
  }
  return work;
}

function buildEvents(
  db: Database,
  projectId: string,
  workIds: ReadonlySet<string>,
  warnings: WarningCollector,
): EventRecord[] {
  const rows = db
    .query<EventRow, [string]>(
      `SELECT event_id, sequence, kind, actor, work_id, from_status, to_status,
              resolution, summary, details
         FROM events WHERE project_id = ? ORDER BY sequence, event_id`,
    )
    .all(projectId);

  const events: EventRecord[] = [];
  for (const row of rows) {
    if (row.event_id === "" || row.sequence < 1) {
      warnings.add(`DATABASE_EVENT_INVALID ${row.event_id}`);
      continue;
    }
    const details = parseObject(row.details, `events.details ${row.event_id}`, warnings);

    let kind = oneOf(EVENT_KINDS, row.kind);
    let normalizedDetails = details;
    if (kind === undefined) {
      warnings.add(`DATABASE_EVENT_KIND_INVALID ${row.event_id}：${row.kind}`);
      kind = "note";
      normalizedDetails = { ...(details ?? {}), originalKind: row.kind };
    }
    const toStatus = oneOf(WORK_STATUSES, row.to_status);
    if (kind === "status_changed" && toStatus === undefined) {
      warnings.add(`DATABASE_EVENT_STATUS_INVALID ${row.event_id}`);
      kind = "note";
      normalizedDetails = { ...(normalizedDetails ?? {}), originalKind: row.kind };
    }
    const event: EventRecord = {
      eventId: row.event_id,
      sequence: row.sequence,
      kind,
      actor: row.actor === "" ? "unknown" : row.actor,
    };
    if (row.work_id !== null && workIds.has(row.work_id)) event.workId = row.work_id;
    const fromStatus = oneOf(WORK_STATUSES, row.from_status);
    if (fromStatus !== undefined) event.fromStatus = fromStatus;
    if (toStatus !== undefined) event.toStatus = toStatus;
    const resolution = oneOf(WORK_RESOLUTIONS, row.resolution);
    if (resolution !== undefined) event.resolution = resolution;
    if (row.summary !== null) event.summary = row.summary;
    if (normalizedDetails !== undefined) {
      event.details = stripTimestampKeys(
        normalizedDetails,
        `events ${row.event_id}`,
        warnings,
      ) as Record<string, unknown>;
    }
    events.push(event);
  }
  return events;
}

function buildEvidence(
  db: Database,
  projectId: string,
  pathSet: ReadonlySet<string>,
  warnings: WarningCollector,
): EvidenceRecord[] {
  const rows = db
    .query<EvidenceRow, [string]>(
      `SELECT evidence_id, work_id, kind, actor, summary, command, output, url, path,
              sha256, details
         FROM evidence WHERE project_id = ? ORDER BY evidence_id`,
    )
    .all(projectId);

  const evidence: EvidenceRecord[] = [];
  for (const row of rows) {
    const kind = oneOf(EVIDENCE_KINDS, row.kind);
    if (kind === undefined || row.evidence_id === "") {
      warnings.add(`DATABASE_EVIDENCE_INVALID ${row.evidence_id}`);
      continue;
    }
    if ((kind === "command" || kind === "test") && (row.command === null || row.command === "")) {
      warnings.add(`DATABASE_EVIDENCE_COMMAND_MISSING ${row.evidence_id}`);
      continue;
    }
    if (kind === "link" && (row.url === null || !/^https?:\/\/\S+$/.test(row.url))) {
      warnings.add(`DATABASE_EVIDENCE_URL_INVALID ${row.evidence_id}`);
      continue;
    }
    const record: EvidenceRecord = {
      evidenceId: row.evidence_id,
      workId: row.work_id,
      kind,
      actor: row.actor === "" ? "unknown" : row.actor,
      summary: row.summary === "" ? kind : row.summary,
    };
    if (row.command !== null) record.command = row.command;
    if (row.output !== null) record.output = row.output;
    if (row.url !== null) record.url = row.url;
    if (row.path !== null) {
      if (!safePackagePath(row.path) || !pathSet.has(row.path)) {
        warnings.add(`DATABASE_EVIDENCE_PATH_MISSING ${row.evidence_id}：${row.path}`);
        continue;
      }
      record.path = row.path;
    }
    if (row.sha256 !== null && SHA256.test(row.sha256)) record.sha256 = row.sha256;
    const details = parseObject(row.details, `evidence.details ${row.evidence_id}`, warnings);
    if (details !== undefined) {
      record.details = stripTimestampKeys(
        details,
        `evidence ${row.evidence_id}`,
        warnings,
      ) as Record<string, unknown>;
    }
    evidence.push(record);
  }
  return evidence;
}

function buildSignals(
  db: Database,
  projectId: string,
  workIds: ReadonlySet<string>,
  warnings: WarningCollector,
): { records: SignalRecord[]; hasGlobal: boolean } {
  const rows = db
    .query<SignalRow, [string]>(
      `SELECT signal_id, scope, kind, content, status, work_id, refs, result_refs,
              reason, details, severity, code
         FROM signals
        WHERE (scope = 'project' AND project_id = ?) OR (scope = 'global' AND project_id IS NULL)
        ORDER BY signal_id`,
    )
    .all(projectId);

  const records: SignalRecord[] = [];
  let hasGlobal = false;
  for (const row of rows) {
    if (row.signal_id === "") {
      warnings.add("DATABASE_SIGNAL_INVALID 空識別碼");
      continue;
    }
    if (row.scope === "global") hasGlobal = true;

    const columnDetails = parseObject(
      row.details,
      `signals.details ${row.signal_id}`,
      warnings,
    );
    let columnSeverity: SignalRecord["severity"] | undefined;
    if (row.severity !== null) {
      columnSeverity = oneOf(SIGNAL_SEVERITIES, row.severity);
      if (columnSeverity === undefined) {
        warnings.add(`DATABASE_SIGNAL_SEVERITY_INVALID ${row.signal_id}：${row.severity}`);
      }
    }
    let columnCode: string | undefined;
    if (row.code !== null) {
      if (row.code.length <= 64 && SIGNAL_CODE.test(row.code)) columnCode = row.code;
      else warnings.add(`DATABASE_SIGNAL_CODE_INVALID ${row.signal_id}：${row.code}`);
    }

    const needsMetadata =
      row.details === null ||
      row.severity === null ||
      row.code === null ||
      columnSeverity === undefined ||
      columnCode === undefined ||
      (row.details !== null && columnDetails === undefined);
    const metadata = needsMetadata
      ? db
          .query<{ value: string }, [string]>("SELECT value FROM metadata WHERE key = ?")
          .get(`signal-export:${row.signal_id}`)
      : null;
    const metadataDetails =
      metadata === null
        ? undefined
        : parseObject(metadata.value, `metadata signal-export:${row.signal_id}`, warnings);
    const exportInfo =
      metadataDetails !== undefined &&
      metadataDetails[SIGNAL_DETAILS_KEY] !== null &&
      typeof metadataDetails[SIGNAL_DETAILS_KEY] === "object"
        ? (metadataDetails[SIGNAL_DETAILS_KEY] as Record<string, unknown>)
        : undefined;

    const severity =
      columnSeverity ??
      (exportInfo !== undefined ? oneOf(SIGNAL_SEVERITIES, exportInfo.severity) : undefined) ??
      "info";
    const metadataCode =
      exportInfo !== undefined &&
      typeof exportInfo.code === "string" &&
      exportInfo.code.length <= 64 &&
      SIGNAL_CODE.test(exportInfo.code)
        ? exportInfo.code
        : undefined;
    const code = columnCode ?? metadataCode ?? signalCode(row.kind);

    const details = columnDetails ?? (metadataDetails === undefined ? undefined : { ...metadataDetails });
    if (details !== undefined) delete details[SIGNAL_DETAILS_KEY];
    const userDetails =
      details === undefined
        ? undefined
        : (stripTimestampKeys(details, `signal ${row.signal_id}`, warnings) as Record<
            string,
            unknown
          >);
    const internal: Record<string, unknown> = {
      scope: row.scope === "global" ? "global" : "project",
      status: row.status,
    };
    const refs = parseStringArray(row.refs, `signals.refs ${row.signal_id}`, warnings);
    if (refs.length > 0) internal.refs = refs;
    const resultRefs = parseStringArray(
      row.result_refs,
      `signals.result_refs ${row.signal_id}`,
      warnings,
    );
    if (resultRefs.length > 0) internal.resultRefs = resultRefs;
    if (row.reason !== null && row.reason !== "") internal.reason = row.reason;

    const signal: SignalRecord = {
      signalId: row.signal_id,
      severity,
      code,
      message: row.content !== "" ? row.content : row.kind !== "" ? row.kind : "signal",
      details: { ...(userDetails ?? {}), [SIGNAL_DETAILS_KEY]: internal },
    };
    if (row.work_id !== null && workIds.has(row.work_id)) signal.workId = row.work_id;
    records.push(signal);
  }
  return { records, hasGlobal };
}

function signalCode(kind: string): string {
  switch (kind) {
    case "correction":
      return "CORRECTION";
    case "failure":
      return "FAILURE";
    case "fix":
      return "FIX";
    case "review_reject":
      return "REVIEW_REJECT";
    case "decision":
      return "DECISION";
    case "lesson":
      return "LESSON";
    default:
      return "SIGNAL";
  }
}

function buildKnowledge(
  db: Database,
  home: string,
  projectId: string,
  workIds: ReadonlySet<string>,
  warnings: WarningCollector,
): { entries: KnowledgeInput[]; hasGlobal: boolean } {
  const rows = db
    .query<KnowledgeRow, [string]>(
      `SELECT id, knowledge_id, layer, kind, type, title, description, pinned, source,
              tags, status, current_version, work_id
         FROM knowledge_entries
        WHERE ((layer = 'project' AND project_id = ?) OR (layer = 'global' AND project_id IS NULL))
        ORDER BY knowledge_id, layer`,
    )
    .all(projectId);

  const entries: KnowledgeInput[] = [];
  const seenIds = new Set<string>();
  let hasGlobal = false;
  for (const row of rows) {
    if (row.layer === "global") hasGlobal = true;
    if (!KNOWLEDGE_ID.test(row.knowledge_id) || seenIds.has(row.knowledge_id)) {
      warnings.add(`DATABASE_KNOWLEDGE_ID_INVALID ${row.knowledge_id}`);
      continue;
    }
    if (row.status === "retired") {
      warnings.add(
        `RETIRED_KNOWLEDGE_STATUS_LOST ${row.knowledge_id}：v1 沒有 status 欄位，匯出後會變成 active`,
      );
    } else if (row.status !== "active") {
      warnings.add(`DATABASE_KNOWLEDGE_STATUS_INVALID ${row.knowledge_id}：${row.status}`);
      continue;
    }
    const type = oneOf(KNOWLEDGE_TYPES, row.type);
    const layer: Layer | undefined = row.layer === "global" ? "global" : "project";
    if (type === undefined) {
      warnings.add(`DATABASE_KNOWLEDGE_TYPE_INVALID ${row.knowledge_id}`);
      continue;
    }
    seenIds.add(row.knowledge_id);

    const versions = db
      .query<VersionRow, [number]>(
        `SELECT entry_id, version, sha256, bytes, snapshot_path
           FROM knowledge_versions WHERE entry_id = ? ORDER BY version`,
      )
      .all(row.id);
    const bodies: KnowledgeVersionBody[] = [];
    const versionEntries: KnowledgeRecord["versions"] = [];
    for (const version of versions) {
      if (version.version < 1) {
        warnings.add(`KNOWLEDGE_VERSION_INVALID ${row.knowledge_id} v${version.version}`);
        continue;
      }
      const absolute = isAbsolute(version.snapshot_path)
        ? version.snapshot_path
        : join(home, version.snapshot_path);
      if (!existsSync(absolute)) {
        warnings.add(`KNOWLEDGE_SNAPSHOT_MISSING ${row.knowledge_id} v${version.version}`);
        continue;
      }
      const bytes = readFileSync(absolute);
      const sha = sha256Bytes(bytes);
      if (sha !== version.sha256) {
        warnings.add(`KNOWLEDGE_HASH_MISMATCH ${row.knowledge_id} v${version.version}`);
      }
      const body = bytes.toString("utf8");
      bodies.push({ version: version.version, body });
      versionEntries.push({
        version: version.version,
        path: `knowledge/files/${row.knowledge_id}/v${version.version}.md`,
        sha256: sha,
        bytes: bytes.byteLength,
      });
    }
    if (bodies.length === 0) {
      warnings.add(`KNOWLEDGE_NO_VERSIONS ${row.knowledge_id}`);
      continue;
    }
    const currentVersion = versionEntries.some(
      (version) => version.version === row.current_version,
    )
      ? row.current_version
      : Math.max(...versionEntries.map((version) => version.version));
    if (currentVersion !== row.current_version) {
      warnings.add(`KNOWLEDGE_CURRENT_VERSION_FALLBACK ${row.knowledge_id}`);
    }

    const record: KnowledgeRecord = {
      knowledgeId: row.knowledge_id,
      type,
      layer,
      title: row.title === "" ? row.knowledge_id : row.title,
      description: row.description,
      pinned: row.pinned === 1,
      source: row.source === "" ? "unknown" : row.source,
      versions: versionEntries,
      currentVersion,
    };
    if (row.work_id !== null && workIds.has(row.work_id)) record.workId = row.work_id;
    const tags = parseStringArray(row.tags, `knowledge_entries.tags ${row.knowledge_id}`, warnings);
    if (tags.length > 0) record.tags = uniqueSorted(tags);
    entries.push({ record, versions: bodies });
  }
  return { entries, hasGlobal };
}

function stripProjectPrefix(projectId: string, sourceId: string): string {
  const prefix = `${projectId}\u0000`;
  return sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
}

function buildRawAndRawMappings(
  db: Database,
  home: string,
  projectId: string,
  warnings: WarningCollector,
): { raw: RawOutput[]; mapping: MappingRecord[] } {
  const rows = db
    .query<MappingRow, [string]>(
      `SELECT entity, layer, source_id, source_record, target_id, source_ref, sha256, note
         FROM id_mappings WHERE entity = 'raw' AND source_root = ?
        ORDER BY layer, source_id`,
    )
    .all(projectId);

  const raw: RawOutput[] = [];
  const mapping: MappingRecord[] = [];
  for (const row of rows) {
    if (row.layer !== "project" && row.layer !== "global") {
      warnings.add(`DATABASE_RAW_LAYER_INVALID ${row.source_id}`);
      continue;
    }
    const sourceRef = row.source_ref;
    if (sourceRef === null || !safePackagePath(sourceRef)) {
      warnings.add(`DATABASE_RAW_PATH_INVALID ${row.source_id}`);
      continue;
    }
    const prefix = `raw/${row.layer}/`;
    if (!sourceRef.startsWith(prefix)) {
      warnings.add(`DATABASE_RAW_PATH_INVALID ${sourceRef}`);
      continue;
    }
    const path = sourceRef.slice(prefix.length);
    const sha = row.target_id;
    if (!SHA256.test(sha)) {
      warnings.add(`DATABASE_RAW_HASH_INVALID ${sourceRef}`);
      continue;
    }
    const blob = join(home, "blobs", sha.slice(0, 2), sha);
    if (!existsSync(blob)) {
      throw new ExportCurrentError("RAW_BLOB_MISSING", `找不到 raw 內容：${sourceRef}`, [blob]);
    }
    const bytes = readFileSync(blob);
    if (sha256Bytes(bytes) !== sha) {
      throw new ExportCurrentError("RAW_BLOB_CORRUPT", `raw 內容與雜湊不符：${sourceRef}`, [blob]);
    }
    raw.push({ layer: row.layer, path, bytes });
    mapping.push({
      entity: "raw",
      layer: row.layer,
      sourceRoot: row.layer === "project" ? "raw/project" : "raw/global",
      sourceId: stripProjectPrefix(projectId, row.source_id),
      targetId: sourceRef,
      sourceRef,
      sha256: sha,
      ...(row.note === null || row.note.length > 2000 ? {} : { note: row.note }),
    });
  }
  raw.sort((left, right) => {
    const layer = compareCodePoints(left.layer, right.layer);
    return layer !== 0 ? layer : compareCodePoints(left.path, right.path);
  });
  return { raw, mapping };
}

function buildNonRawMappings(
  db: Database,
  projectId: string,
  ids: {
    work: ReadonlySet<string>;
    event: ReadonlySet<string>;
    evidence: ReadonlySet<string>;
    signal: ReadonlySet<string>;
    knowledge: ReadonlyMap<string, Layer>;
  },
  pathSet: ReadonlySet<string>,
  warnings: WarningCollector,
): MappingRecord[] {
  const rows = db
    .query<MappingRow, [string]>(
      `SELECT entity, layer, source_id, source_record, target_id, source_ref, sha256, note
         FROM id_mappings WHERE source_root = ? AND entity != 'raw'
        ORDER BY entity, layer, source_id, target_id`,
    )
    .all(projectId);

  const mapping: MappingRecord[] = [];
  for (const row of rows) {
    if (row.layer !== "project" && row.layer !== "global") {
      warnings.add(`DATABASE_MAPPING_LAYER_INVALID ${row.source_id}`);
      continue;
    }
    if (!["work", "event", "evidence", "signal", "knowledge"].includes(row.entity)) {
      warnings.add(`DATABASE_MAPPING_ENTITY_INVALID ${row.entity}`);
      continue;
    }
    if (row.source_record === null || row.source_record === "") {
      warnings.add(`DATABASE_MAPPING_SOURCE_RECORD_MISSING ${row.source_id}`);
      continue;
    }
    if (row.source_ref === null || !pathSet.has(row.source_ref)) {
      warnings.add(`DATABASE_MAPPING_SOURCE_REF_MISSING ${row.source_id}`);
      continue;
    }
    if (row.entity === "knowledge") {
      if (ids.knowledge.get(row.target_id) !== row.layer) {
        warnings.add(`DATABASE_MAPPING_TARGET_MISSING ${row.source_id}`);
        continue;
      }
    } else {
      const targetSet = ids[row.entity as keyof typeof ids];
      if (!(targetSet as ReadonlySet<string>).has(row.target_id)) {
        warnings.add(`DATABASE_MAPPING_TARGET_MISSING ${row.source_id}`);
        continue;
      }
    }
    mapping.push({
      entity: row.entity as MappingRecord["entity"],
      layer: row.layer,
      sourceRoot: row.layer === "project" ? "raw/project" : "raw/global",
      sourceId: stripProjectPrefix(projectId, row.source_id),
      sourceRecord: row.source_record,
      targetId: row.target_id,
      sourceRef: row.source_ref,
      ...(row.note === null || row.note.length > 2000 ? {} : { note: row.note }),
    });
  }
  return mapping;
}

function compareMappings(left: MappingRecord, right: MappingRecord): number {
  const entity = compareCodePoints(left.entity, right.entity);
  if (entity !== 0) return entity;
  const layer = compareCodePoints(left.layer, right.layer);
  if (layer !== 0) return layer;
  const source = compareCodePoints(left.sourceId, right.sourceId);
  if (source !== 0) return source;
  return compareCodePoints(left.targetId, right.targetId);
}

export interface BuildCurrentOptions {
  home: string;
  projectId: string;
  createdAt: string;
  producerVersion: string;
}

export function buildCurrentPackage(
  db: Database,
  options: BuildCurrentOptions,
  warnings: WarningCollector,
): CurrentPackage {
  const work = buildWork(db, options.projectId, warnings);
  const workIds = new Set(work.map((record) => record.workId));

  const rawBuild = buildRawAndRawMappings(db, options.home, options.projectId, warnings);
  const knowledgeBuild = buildKnowledge(
    db,
    options.home,
    options.projectId,
    workIds,
    warnings,
  );

  const pathSet = new Set<string>([
    ...rawBuild.raw.map((file) => `raw/${file.layer}/${file.path}`),
    ...knowledgeBuild.entries.flatMap((entry) =>
      entry.record.versions.map((version) => version.path),
    ),
  ]);

  const events = buildEvents(db, options.projectId, workIds, warnings);
  const evidence = buildEvidence(db, options.projectId, pathSet, warnings);
  const signalBuild = buildSignals(db, options.projectId, workIds, warnings);

  const ids = {
    work: workIds,
    event: new Set(events.map((record) => record.eventId)),
    evidence: new Set(evidence.map((record) => record.evidenceId)),
    signal: new Set(signalBuild.records.map((record) => record.signalId)),
    knowledge: new Map(
      knowledgeBuild.entries.map((entry) => [entry.record.knowledgeId, entry.record.layer]),
    ),
  };

  const mapping = [
    ...rawBuild.mapping,
    ...buildNonRawMappings(db, options.projectId, ids, pathSet, warnings),
  ].sort(compareMappings);

  const layers: Layer[] = ["project"];
  if (knowledgeBuild.hasGlobal || rawBuild.raw.some((file) => file.layer === "global") || signalBuild.hasGlobal) {
    layers.push("global");
  }
  for (const record of mapping) {
    if (record.layer === "global" && !layers.includes("global")) layers.push("global");
  }

  const manifest: Manifest = {
    format: "smilework-export",
    formatVersion: 1,
    createdAt: options.createdAt,
    producer: { name: "smilework", version: options.producerVersion },
    source: { kind: "smilework-db", projectId: options.projectId, layers },
    layout: {
      manifest: { path: "manifest.json" },
      work: { path: "work.jsonl", records: work.length },
      events: { path: "events.jsonl", records: events.length },
      evidence: { path: "evidence.jsonl", records: evidence.length },
      signals: { path: "signals.jsonl", records: signalBuild.records.length },
      knowledge: {
        path: "knowledge/",
        entries: knowledgeBuild.entries.length,
        files: knowledgeBuild.entries.reduce((total, entry) => total + entry.versions.length, 0),
      },
      mapping: { path: "mapping.jsonl", records: mapping.length },
      raw: {
        path: "raw/",
        files: rawBuild.raw.length,
        projectFiles: rawBuild.raw.filter((file) => file.layer === "project").length,
        globalFiles: rawBuild.raw.filter((file) => file.layer === "global").length,
      },
    },
    warnings: warnings.all(),
  };

  return {
    manifest,
    work,
    events,
    evidence,
    signals: signalBuild.records,
    knowledge: knowledgeBuild.entries,
    mapping,
    raw: rawBuild.raw,
  };
}
