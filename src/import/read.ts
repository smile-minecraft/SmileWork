import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { sha256Bytes } from "../export/v3/canonical.ts";
import { ImportError } from "./errors.ts";
import type {
  EvidenceRecord,
  EventRecord,
  KnowledgeInput,
  KnowledgeRecord,
  KnowledgeVersionBody,
  KnowledgeVersionEntry,
  Layer,
  Manifest,
  MappingEntity,
  MappingRecord,
  PackageContents,
  ParsedSignal,
  RawFile,
  SignalRecord,
  WorkAcceptanceResultItem,
  WorkAcceptanceResults,
  WorkRecord,
  WorkReview,
} from "./types.ts";
import {
  EVIDENCE_KINDS,
  EVENT_KINDS,
  KNOWLEDGE_TYPES,
  LAYERS,
  MAPPING_ENTITIES,
  RISK_LEVELS,
  SIGNAL_DETAILS_KEY,
  SIGNAL_SEVERITIES,
  SIGNAL_STATUSES,
  WORK_KINDS,
  WORK_RESOLUTIONS,
  WORK_STATUSES,
} from "./types.ts";
import { WarningCollector } from "./warnings.ts";

const TOP_LEVEL = new Set([
  "manifest.json",
  "work.jsonl",
  "events.jsonl",
  "evidence.jsonl",
  "signals.jsonl",
  "knowledge",
  "mapping.jsonl",
  "raw",
]);

const KNOWLEDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PACKAGE_PATH = /^(?:raw\/(?:project|global)|knowledge)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNAL_CODE = /^[A-Z][A-Z0-9_]*$/;

const WORK_KEYS = new Set([
  "workId",
  "kind",
  "title",
  "status",
  "resolution",
  "owner",
  "priority",
  "planId",
  "dependsOn",
  "objective",
  "nonGoals",
  "contextRefs",
  "scopePaths",
  "acceptance",
  "risk",
  "review",
  "acceptanceResults",
]);

const EVENT_KEYS = new Set([
  "eventId",
  "sequence",
  "kind",
  "actor",
  "workId",
  "fromStatus",
  "toStatus",
  "resolution",
  "summary",
  "details",
]);

const EVIDENCE_KEYS = new Set([
  "evidenceId",
  "workId",
  "kind",
  "actor",
  "summary",
  "command",
  "output",
  "url",
  "path",
  "sha256",
  "details",
]);

const SIGNAL_KEYS = new Set(["signalId", "severity", "code", "message", "workId", "details"]);

const KNOWLEDGE_KEYS = new Set([
  "knowledgeId",
  "type",
  "layer",
  "title",
  "description",
  "pinned",
  "source",
  "versions",
  "currentVersion",
  "workId",
  "tags",
]);

const VERSION_KEYS = new Set(["version", "path", "sha256", "bytes"]);

const MAPPING_KEYS = new Set([
  "entity",
  "layer",
  "sourceRoot",
  "sourceId",
  "sourceRecord",
  "targetId",
  "sourceRef",
  "sha256",
  "note",
]);

interface JsonLineEntry {
  file: string;
  line: number;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function nonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return undefined;
    result.push(item);
  }
  return result;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string") ? [...value] : undefined;
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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function safeRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\")) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function unknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  file: string,
  line: number,
  warnings: WarningCollector,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      warnings.add(`UNKNOWN_FIELD ${file} 第 ${line} 行：${key}`);
    }
  }
}

function invalid(
  code: string,
  file: string,
  line: number,
  warnings: WarningCollector,
  detail: string,
): void {
  warnings.add(`${code} ${file} 第 ${line} 行：${detail}`);
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ImportError("MANIFEST_UNREADABLE", `無法讀取 ${path}`, [String(error)]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ImportError("MANIFEST_INVALID", `${path} 不是合法 JSON`, [String(error)]);
  }
}

function readJsonLines(path: string, relative: string, warnings: WarningCollector): JsonLineEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ImportError("CORE_FILE_MISSING", `缺少核心檔案：${relative}`, [String(error)]);
  }
  text = text.replace(/^\uFEFF/, "");
  if (text === "") return [];
  if (!text.endsWith("\n")) {
    warnings.add(`JSONL_NO_TRAILING_NEWLINE ${relative}`);
  }
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const entries: JsonLineEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      warnings.add(`EMPTY_LINE ${relative} 第 ${lineNumber} 行`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      warnings.add(`MALFORMED_JSON ${relative} 第 ${lineNumber} 行：${String(error)}`);
      continue;
    }
    if (!isRecord(value)) {
      invalid("INVALID_RECORD", relative, lineNumber, warnings, "每行必須是 JSON 物件");
      continue;
    }
    entries.push({ file: relative, line: lineNumber, value });
  }
  return entries;
}

function validateManifest(value: unknown, warnings: WarningCollector): Manifest {
  if (!isRecord(value)) {
    throw new ImportError("MANIFEST_INVALID", "manifest.json 必須是 JSON 物件");
  }
  if (value.format !== "smilework-export") {
    throw new ImportError(
      "MANIFEST_INVALID",
      `manifest.format 必須是 smilework-export，收到 ${String(value.format)}`,
    );
  }
  if (value.formatVersion !== 1) {
    throw new ImportError(
      "UNSUPPORTED_FORMAT_VERSION",
      `不支援的格式版本：${String(value.formatVersion)}，這個工具只支援 1`,
    );
  }
  if (!isRecord(value.source)) {
    throw new ImportError("MANIFEST_INVALID", "manifest.source 必須是物件");
  }
  const projectId = nonEmptyString(value.source.projectId);
  if (projectId === undefined || projectId.includes("\u0000")) {
    throw new ImportError("MANIFEST_INVALID", "manifest.source.projectId 不能是空字串或含 NUL");
  }
  const layers = Array.isArray(value.source.layers)
    ? value.source.layers.filter((layer): layer is Layer => layer === "project" || layer === "global")
    : [];
  if (layers.length === 0) {
    throw new ImportError("MANIFEST_INVALID", "manifest.source.layers 至少要有一層");
  }
  if (!isRecord(value.layout)) {
    warnings.add("MANIFEST_LAYOUT_INVALID manifest.layout 不是物件，計數只以實際內容為準");
  }
  const manifest: Manifest = {
    format: "smilework-export",
    formatVersion: 1,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    producer: isRecord(value.producer)
      ? {
          name: "smilework",
          version: typeof value.producer.version === "string" ? value.producer.version : "0.0.0",
        }
      : { name: "smilework", version: "0.0.0" },
    source: {
      kind: value.source.kind === "smilework-db" ? "smilework-db" : "ultrawork-v3",
      projectId,
      ...(nonEmptyString(value.source.projectPath) === undefined
        ? {}
        : { projectPath: nonEmptyString(value.source.projectPath)! }),
      ...(nonEmptyString(value.source.registryVersion) === undefined
        ? {}
        : { registryVersion: nonEmptyString(value.source.registryVersion)! }),
      layers: uniqueSorted(layers) as Layer[],
    },
    layout: {
      manifest: { path: "manifest.json" },
      work: { path: "work.jsonl", records: 0 },
      events: { path: "events.jsonl", records: 0 },
      evidence: { path: "evidence.jsonl", records: 0 },
      signals: { path: "signals.jsonl", records: 0 },
      knowledge: { path: "knowledge/", entries: 0, files: 0 },
      mapping: { path: "mapping.jsonl", records: 0 },
      raw: { path: "raw/", files: 0, projectFiles: 0, globalFiles: 0 },
    },
    warnings: [],
  };

  if (isRecord(value.layout)) {
    const layout = value.layout;
    manifest.layout = {
      manifest: { path: "manifest.json" },
      work: { path: "work.jsonl", records: layoutCount(layout, "work", "records") },
      events: { path: "events.jsonl", records: layoutCount(layout, "events", "records") },
      evidence: { path: "evidence.jsonl", records: layoutCount(layout, "evidence", "records") },
      signals: { path: "signals.jsonl", records: layoutCount(layout, "signals", "records") },
      knowledge: {
        path: "knowledge/",
        entries: layoutCount(layout, "knowledge", "entries"),
        files: layoutCount(layout, "knowledge", "files"),
      },
      mapping: { path: "mapping.jsonl", records: layoutCount(layout, "mapping", "records") },
      raw: {
        path: "raw/",
        files: layoutCount(layout, "raw", "files"),
        projectFiles: layoutCount(layout, "raw", "projectFiles"),
        globalFiles: layoutCount(layout, "raw", "globalFiles"),
      },
    };
  }

  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings) {
      if (typeof warning === "string" && warning.trim() !== "") warnings.add(warning);
    }
  }
  return manifest;
}

function layoutCount(
  layout: Record<string, unknown>,
  part: string,
  field: string,
): number {
  const section = layout[part];
  if (!isRecord(section)) return 0;
  const value = section[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeWork(
  entry: JsonLineEntry,
  warnings: WarningCollector,
): WorkRecord | undefined {
  const record = entry.value as Record<string, unknown>;
  unknownKeys(record, WORK_KEYS, entry.file, entry.line, warnings);

  const workId = nonEmptyString(record.workId);
  if (workId === undefined || workId.length > 256) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "workId 必須是 1 到 256 字元的字串");
    return undefined;
  }
  const kind = oneOf(WORK_KINDS, record.kind);
  if (kind === undefined) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "kind 必須是 task 或 plan");
    return undefined;
  }
  const title = nonEmptyString(record.title);
  if (title === undefined) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "title 不能是空字串");
    return undefined;
  }
  const status = oneOf(WORK_STATUSES, record.status);
  if (status === undefined) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "status 不是允許的值");
    return undefined;
  }

  let resolution = oneOf(WORK_RESOLUTIONS, record.resolution);
  if (status === "done") {
    if (resolution !== "completed" && resolution !== "failed") {
      invalid("INVALID_RECORD", entry.file, entry.line, warnings, "done 需要 completed 或 failed");
      return undefined;
    }
  } else if (status === "cancelled") {
    if (resolution === undefined) {
      warnings.add(`MISSING_RESOLUTION ${entry.file} 第 ${entry.line} 行：cancelled 補成 abandoned`);
      resolution = "abandoned";
    } else if (resolution !== "abandoned") {
      invalid("INVALID_RECORD", entry.file, entry.line, warnings, "cancelled 只能是 abandoned");
      return undefined;
    }
  } else if (resolution !== undefined) {
    warnings.add(`UNEXPECTED_RESOLUTION ${entry.file} 第 ${entry.line} 行：非終態忽略 resolution`);
    resolution = undefined;
  }

  let owner = nonEmptyString(record.owner);
  if (owner === undefined) {
    warnings.add(`MISSING_OWNER ${entry.file} 第 ${entry.line} 行：補成 unknown`);
    owner = "unknown";
  }
  let priority = nonEmptyString(record.priority);
  if (priority === undefined || priority.length > 32) {
    warnings.add(`MISSING_PRIORITY ${entry.file} 第 ${entry.line} 行：補成 medium`);
    priority = "medium";
  }

  const work: WorkRecord = { workId, kind, title, status, owner, priority };
  if (resolution !== undefined) work.resolution = resolution;

  const planId = nonEmptyString(record.planId);
  if (planId !== undefined) work.planId = planId;

  const dependsOn = nonEmptyStrings(record.dependsOn);
  if (dependsOn !== undefined) {
    const unique = orderedUnique(dependsOn);
    if (unique.length > 0) work.dependsOn = uniqueSorted(unique);
  } else if (record.dependsOn !== undefined) {
    warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：dependsOn 必須是字串陣列`);
  }

  const objective = nonEmptyString(record.objective);
  if (objective !== undefined) {
    if (objective.length <= 2000) work.objective = objective;
    else warnings.add(`FIELD_TOO_LONG ${entry.file} 第 ${entry.line} 行：objective 超過 2000 字元`);
  } else if (record.objective !== undefined && record.objective !== "") {
    warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：objective 必須是非空字串`);
  }

  for (const field of ["nonGoals", "contextRefs", "scopePaths"] as const) {
    const values = nonEmptyStrings(record[field]);
    if (values === undefined) {
      if (record[field] !== undefined) {
        warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：${field} 必須是非空字串陣列`);
      }
      continue;
    }
    const unique = uniqueSorted(values);
    if (unique.length > 0) work[field] = unique;
    else warnings.add(`EMPTY_FIELD ${entry.file} 第 ${entry.line} 行：${field} 空陣列已省略`);
  }

  const acceptance = nonEmptyStrings(record.acceptance);
  if (acceptance !== undefined) {
    const unique = orderedUnique(acceptance);
    if (unique.length !== acceptance.length) {
      warnings.add(`DUPLICATE_ACCEPTANCE ${entry.file} 第 ${entry.line} 行：保留第一次出現的順序`);
    }
    const bounded = unique.filter((criterion) => criterion.length <= 1000);
    if (bounded.length !== unique.length) {
      warnings.add(`FIELD_TOO_LONG ${entry.file} 第 ${entry.line} 行：acceptance 超過 1000 字元`);
    }
    if (bounded.length > 0) work.acceptance = bounded;
  } else if (record.acceptance !== undefined) {
    warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：acceptance 必須是非空字串陣列`);
  }

  const risk = oneOf(RISK_LEVELS, record.risk);
  if (risk !== undefined) work.risk = risk;
  else if (record.risk !== undefined) {
    warnings.add(`UNMAPPED_RISK ${entry.file} 第 ${entry.line} 行：${String(record.risk)}`);
  }

  const review = normalizeReview(record.review, entry, warnings);
  if (review !== undefined) work.review = review;

  const acceptanceResults = normalizeAcceptanceResults(
    record.acceptanceResults,
    work.acceptance,
    entry,
    warnings,
  );
  if (acceptanceResults !== undefined) work.acceptanceResults = acceptanceResults;

  return work;
}

function normalizeReview(
  value: unknown,
  entry: JsonLineEntry,
  warnings: WarningCollector,
): WorkReview | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.add(`INVALID_REVIEW ${entry.file} 第 ${entry.line} 行：review 必須是物件`);
    return undefined;
  }
  const verdict =
    value.verdict === "approve" || value.verdict === "concerns" || value.verdict === "reject"
      ? value.verdict
      : undefined;
  const reviewer = nonEmptyString(value.reviewer);
  if (verdict === undefined || reviewer === undefined || reviewer.length > 128) {
    warnings.add(`INVALID_REVIEW ${entry.file} 第 ${entry.line} 行：verdict 或 reviewer 不合法`);
    return undefined;
  }
  const review: WorkReview = { verdict, reviewer };
  const note = stringValue(value.note);
  if (note !== undefined && note !== "" && note.length <= 4000) review.note = note;
  else if (note !== undefined && note.length > 4000) {
    warnings.add(`FIELD_TOO_LONG ${entry.file} 第 ${entry.line} 行：review.note 超過 4000 字元`);
  }
  if (typeof value.reworkedAfterReview === "boolean") {
    review.reworkedAfterReview = value.reworkedAfterReview;
  }
  return review;
}

function normalizeAcceptanceResults(
  value: unknown,
  acceptance: readonly string[] | undefined,
  entry: JsonLineEntry,
  warnings: WarningCollector,
): WorkAcceptanceResults | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.add(`INVALID_ACCEPTANCE_RESULTS ${entry.file} 第 ${entry.line} 行：必須是物件`);
    return undefined;
  }
  const recordedBy = nonEmptyString(value.recordedBy);
  if (recordedBy === undefined || !Array.isArray(value.items) || value.items.length === 0) {
    warnings.add(`INVALID_ACCEPTANCE_RESULTS ${entry.file} 第 ${entry.line} 行：recordedBy 或 items 不合法`);
    return undefined;
  }
  const items: WorkAcceptanceResultItem[] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) {
      warnings.add(`INVALID_ACCEPTANCE_RESULTS ${entry.file} 第 ${entry.line} 行：item 不是物件`);
      return undefined;
    }
    const criterion = nonEmptyString(rawItem.criterion);
    if (criterion === undefined || criterion.length > 1000 || typeof rawItem.met !== "boolean") {
      warnings.add(`INVALID_ACCEPTANCE_RESULTS ${entry.file} 第 ${entry.line} 行：criterion 或 met 不合法`);
      return undefined;
    }
    const item: WorkAcceptanceResultItem = { criterion, met: rawItem.met };
    const evidence = stringValue(rawItem.evidence);
    if (evidence !== undefined && evidence !== "" && evidence.length <= 4000) {
      item.evidence = evidence;
    }
    items.push(item);
  }
  if (
    acceptance === undefined ||
    items.length !== acceptance.length ||
    items.some((item, index) => item.criterion !== acceptance[index])
  ) {
    warnings.add(`ACCEPTANCE_MISMATCH ${entry.file} 第 ${entry.line} 行：與 acceptance 沒有逐項對齊`);
    return undefined;
  }
  return { recordedBy, items };
}

function normalizeEvent(
  entry: JsonLineEntry,
  warnings: WarningCollector,
): EventRecord | undefined {
  const record = entry.value as Record<string, unknown>;
  unknownKeys(record, EVENT_KEYS, entry.file, entry.line, warnings);

  const eventId = nonEmptyString(record.eventId);
  const sequence = integerValue(record.sequence);
  const kind = oneOf(EVENT_KINDS, record.kind);
  const actor = nonEmptyString(record.actor);
  if (
    eventId === undefined ||
    eventId.length > 256 ||
    sequence === undefined ||
    sequence < 1 ||
    kind === undefined ||
    actor === undefined
  ) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "eventId、sequence、kind 或 actor 不合法");
    return undefined;
  }

  const event: EventRecord = { eventId, sequence, kind, actor };
  const workId = nonEmptyString(record.workId);
  if (workId !== undefined) event.workId = workId;

  const fromStatus = oneOf(WORK_STATUSES, record.fromStatus);
  if (fromStatus !== undefined) event.fromStatus = fromStatus;
  else if (record.fromStatus !== undefined) {
    warnings.add(`INVALID_STATUS ${entry.file} 第 ${entry.line} 行：fromStatus`);
  }

  const toStatus = oneOf(WORK_STATUSES, record.toStatus);
  if (toStatus !== undefined) event.toStatus = toStatus;
  else if (record.toStatus !== undefined) {
    warnings.add(`INVALID_STATUS ${entry.file} 第 ${entry.line} 行：toStatus`);
  }
  if (kind === "status_changed" && toStatus === undefined) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "status_changed 需要有效的 toStatus");
    return undefined;
  }

  const resolution = oneOf(WORK_RESOLUTIONS, record.resolution);
  if (resolution !== undefined) event.resolution = resolution;
  else if (record.resolution !== undefined) {
    warnings.add(`INVALID_RESOLUTION ${entry.file} 第 ${entry.line} 行`);
  }

  const summary = stringValue(record.summary);
  if (summary !== undefined) event.summary = summary;

  if (record.details !== undefined) {
    if (isRecord(record.details)) event.details = record.details;
    else warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：details 必須是物件`);
  }
  return event;
}

function normalizeEvidence(
  entry: JsonLineEntry,
  warnings: WarningCollector,
): EvidenceRecord | undefined {
  const record = entry.value as Record<string, unknown>;
  unknownKeys(record, EVIDENCE_KEYS, entry.file, entry.line, warnings);

  const evidenceId = nonEmptyString(record.evidenceId);
  const workId = nonEmptyString(record.workId);
  const kind = oneOf(EVIDENCE_KINDS, record.kind);
  const actor = nonEmptyString(record.actor);
  const summary = nonEmptyString(record.summary);
  if (
    evidenceId === undefined ||
    evidenceId.length > 256 ||
    workId === undefined ||
    workId.length > 256 ||
    kind === undefined ||
    actor === undefined ||
    summary === undefined
  ) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "必要欄位不合法");
    return undefined;
  }

  const evidence: EvidenceRecord = { evidenceId, workId, kind, actor, summary };
  const command = nonEmptyString(record.command);
  if (kind === "command" || kind === "test") {
    if (command === undefined) {
      invalid("INVALID_RECORD", entry.file, entry.line, warnings, `${kind} 需要 command`);
      return undefined;
    }
    evidence.command = command;
  } else if (command !== undefined) {
    evidence.command = command;
  }

  const output = stringValue(record.output);
  if (output !== undefined) evidence.output = output;

  const url = stringValue(record.url);
  if (kind === "link") {
    if (url === undefined || !/^https?:\/\/\S+$/.test(url)) {
      invalid("INVALID_RECORD", entry.file, entry.line, warnings, "link 需要 http(s) URL");
      return undefined;
    }
    evidence.url = url;
  } else if (url !== undefined) {
    evidence.url = url;
  }

  const path = stringValue(record.path);
  if (kind === "artifact") {
    if (path === undefined || !PACKAGE_PATH.test(path) || !safeRelativePath(path)) {
      invalid("INVALID_RECORD", entry.file, entry.line, warnings, "artifact 需要套件內安全相對路徑");
      return undefined;
    }
    evidence.path = path;
  } else if (path !== undefined) {
    if (PACKAGE_PATH.test(path) && safeRelativePath(path)) evidence.path = path;
    else warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：path 不是套件內路徑`);
  }

  const sha256 = stringValue(record.sha256);
  if (sha256 !== undefined) {
    if (SHA256.test(sha256)) evidence.sha256 = sha256;
    else warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：sha256 格式不對`);
  }

  if (record.details !== undefined) {
    if (isRecord(record.details)) evidence.details = record.details;
    else warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：details 必須是物件`);
  }
  return evidence;
}

function normalizeSignalSeverity(
  value: unknown,
  entry: JsonLineEntry,
  warnings: WarningCollector,
): SignalRecord["severity"] {
  const severity = oneOf(SIGNAL_SEVERITIES, value);
  if (severity !== undefined) return severity;
  warnings.add(
    `INVALID_SIGNAL_SEVERITY ${entry.file} 第 ${entry.line} 行：${String(value)}，改用 info`,
  );
  return "info";
}

function normalizeSignalCode(
  value: unknown,
  entry: JsonLineEntry,
  warnings: WarningCollector,
): string {
  if (typeof value === "string" && value !== "") {
    if (value.length <= 64 && SIGNAL_CODE.test(value)) return value;
    warnings.add(`INVALID_SIGNAL_CODE ${entry.file} 第 ${entry.line} 行：${value}`);
    const sanitized = value
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .replace(/^[^A-Z]+/, "")
      .slice(0, 64)
      .replace(/_+$/, "");
    if (sanitized !== "" && SIGNAL_CODE.test(sanitized)) return sanitized;
    return "SIGNAL";
  }
  warnings.add(`INVALID_SIGNAL_CODE ${entry.file} 第 ${entry.line} 行：缺少 code，改用 SIGNAL`);
  return "SIGNAL";
}

function normalizeSignal(
  entry: JsonLineEntry,
  warnings: WarningCollector,
): ParsedSignal | undefined {
  const record = entry.value as Record<string, unknown>;
  unknownKeys(record, SIGNAL_KEYS, entry.file, entry.line, warnings);

  const signalId = nonEmptyString(record.signalId);
  const message = nonEmptyString(record.message);
  if (signalId === undefined || signalId.length > 256 || message === undefined) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "signalId 或 message 不合法");
    return undefined;
  }

  const signal: ParsedSignal = {
    signalId,
    severity: normalizeSignalSeverity(record.severity, entry, warnings),
    code: normalizeSignalCode(record.code, entry, warnings),
    message,
  };
  const workId = nonEmptyString(record.workId);
  if (workId !== undefined) signal.workId = workId;

  if (record.details !== undefined) {
    if (isRecord(record.details)) {
      const details = { ...record.details };
      const internal = details[SIGNAL_DETAILS_KEY];
      delete details[SIGNAL_DETAILS_KEY];
      if (Object.keys(details).length > 0) signal.details = details;
      if (isRecord(internal)) {
        const scope = oneOf(LAYERS, internal.scope);
        if (scope !== undefined) signal.scope = scope;
        else if (internal.scope !== undefined) {
          warnings.add(
            `INVALID_SIGNAL_SCOPE ${entry.file} 第 ${entry.line} 行：${String(internal.scope)}`,
          );
        }
        const status = oneOf(SIGNAL_STATUSES, internal.status);
        if (status !== undefined) signal.status = status;
        else if (internal.status !== undefined) {
          warnings.add(
            `INVALID_SIGNAL_STATUS ${entry.file} 第 ${entry.line} 行：${String(internal.status)}`,
          );
        }
        const refs = stringList(internal.refs);
        if (refs !== undefined) signal.refs = refs;
        else if (internal.refs !== undefined) {
          warnings.add(`INVALID_SIGNAL_REFS ${entry.file} 第 ${entry.line} 行`);
        }
        const resultRefs = stringList(internal.resultRefs);
        if (resultRefs !== undefined) signal.resultRefs = resultRefs;
        else if (internal.resultRefs !== undefined) {
          warnings.add(`INVALID_SIGNAL_RESULT_REFS ${entry.file} 第 ${entry.line} 行`);
        }
        const reason = stringValue(internal.reason);
        if (reason !== undefined) signal.reason = reason;
        else if (internal.reason !== undefined) {
          warnings.add(`INVALID_SIGNAL_REASON ${entry.file} 第 ${entry.line} 行`);
        }
      } else if (internal !== undefined) {
        warnings.add(`INVALID_SIGNAL_DETAILS ${entry.file} 第 ${entry.line} 行`);
      }
    } else {
      warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：details 必須是物件`);
    }
  }
  return signal;
}

interface RawKnowledge {
  record: Omit<KnowledgeRecord, "versions">;
  rawVersions: Array<Omit<KnowledgeVersionEntry, "path"> & { path: string }>;
}

function normalizeKnowledge(
  entry: JsonLineEntry,
  warnings: WarningCollector,
): RawKnowledge | undefined {
  const record = entry.value as Record<string, unknown>;
  unknownKeys(record, KNOWLEDGE_KEYS, entry.file, entry.line, warnings);

  const knowledgeId = stringValue(record.knowledgeId);
  if (
    knowledgeId === undefined ||
    knowledgeId.length > 128 ||
    !KNOWLEDGE_ID.test(knowledgeId)
  ) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "knowledgeId 不是安全識別碼");
    return undefined;
  }
  const type = oneOf(KNOWLEDGE_TYPES, record.type);
  const layer = oneOf(LAYERS, record.layer);
  const title = nonEmptyString(record.title);
  const description = stringValue(record.description);
  const pinned = booleanValue(record.pinned);
  const source = nonEmptyString(record.source);
  if (
    type === undefined ||
    layer === undefined ||
    title === undefined ||
    description === undefined ||
    pinned === undefined ||
    source === undefined
  ) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "知識項目的必要欄位不合法");
    return undefined;
  }

  const rawVersions: RawKnowledge["rawVersions"] = [];
  const seenVersions = new Set<number>();
  if (!Array.isArray(record.versions) || record.versions.length === 0) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "versions 至少要有一筆");
    return undefined;
  }
  for (const [index, versionValue] of record.versions.entries()) {
    if (!isRecord(versionValue)) {
      warnings.add(`INVALID_KNOWLEDGE_VERSION ${entry.file} 第 ${entry.line} 行：第 ${index + 1} 筆不是物件`);
      continue;
    }
    unknownKeys(versionValue, VERSION_KEYS, `${entry.file}（versions[${index}]）`, entry.line, warnings);
    const version = integerValue(versionValue.version);
    const path = stringValue(versionValue.path);
    const sha256 = stringValue(versionValue.sha256);
    const bytes = integerValue(versionValue.bytes);
    if (
      version === undefined ||
      version < 1 ||
      path === undefined ||
      sha256 === undefined ||
      !SHA256.test(sha256) ||
      bytes === undefined ||
      bytes < 0
    ) {
      warnings.add(`INVALID_KNOWLEDGE_VERSION ${entry.file} 第 ${entry.line} 行：第 ${index + 1} 筆欄位不合法`);
      continue;
    }
    const expectedPath = `knowledge/files/${knowledgeId}/v${version}.md`;
    if (path !== expectedPath) {
      warnings.add(`INVALID_KNOWLEDGE_VERSION ${entry.file} 第 ${entry.line} 行：path 應為 ${expectedPath}`);
      continue;
    }
    if (seenVersions.has(version)) {
      warnings.add(`DUPLICATE_KNOWLEDGE_VERSION ${entry.file} 第 ${entry.line} 行：v${version}`);
      continue;
    }
    seenVersions.add(version);
    rawVersions.push({ version, path, sha256, bytes });
  }
  if (rawVersions.length === 0) {
    invalid("INVALID_RECORD", entry.file, entry.line, warnings, "沒有可讀的知識版本");
    return undefined;
  }

  const currentVersion = integerValue(record.currentVersion);
  let chosenCurrent = currentVersion;
  if (
    chosenCurrent === undefined ||
    !rawVersions.some((version) => version.version === chosenCurrent)
  ) {
    const fallback = Math.max(...rawVersions.map((version) => version.version));
    warnings.add(
      `KNOWLEDGE_CURRENT_VERSION_FALLBACK ${entry.file} 第 ${entry.line} 行：改用 v${fallback}`,
    );
    chosenCurrent = fallback;
  }

  const workId = nonEmptyString(record.workId);
  const tags = nonEmptyStrings(record.tags);
  const base: Omit<KnowledgeRecord, "versions"> = {
    knowledgeId,
    type,
    layer,
    title,
    description,
    pinned,
    source,
    currentVersion: chosenCurrent,
  };
  if (workId !== undefined) base.workId = workId;
  if (tags !== undefined) {
    const unique = uniqueSorted(tags);
    if (unique.length > 0) base.tags = unique;
  } else if (record.tags !== undefined) {
    warnings.add(`INVALID_FIELD ${entry.file} 第 ${entry.line} 行：tags 必須是非空字串陣列`);
  }
  return { record: base, rawVersions };
}

function normalizeMapping(
  entry: JsonLineEntry,
  warnings: WarningCollector,
): MappingRecord | undefined {
  const record = entry.value as Record<string, unknown>;
  unknownKeys(record, MAPPING_KEYS, entry.file, entry.line, warnings);

  const entity = oneOf(MAPPING_ENTITIES, record.entity);
  const layer = oneOf(LAYERS, record.layer);
  const sourceId = nonEmptyString(record.sourceId);
  const targetId = nonEmptyString(record.targetId);
  const sourceRef = nonEmptyString(record.sourceRef);
  const sourceRoot = record.sourceRoot;
  if (
    entity === undefined ||
    layer === undefined ||
    sourceId === undefined ||
    targetId === undefined ||
    targetId.length > 512 ||
    sourceRef === undefined ||
    (sourceRoot !== "raw/project" && sourceRoot !== "raw/global") ||
    !safeRelativePath(sourceRef) ||
    !safeRelativePath(sourceId)
  ) {
    invalid("INVALID_MAPPING", entry.file, entry.line, warnings, "mapping 必要欄位不合法");
    return undefined;
  }
  const expectedRoot = layer === "project" ? "raw/project" : "raw/global";
  if (sourceRoot !== expectedRoot || !sourceRef.startsWith(`${expectedRoot}/`)) {
    invalid("INVALID_MAPPING", entry.file, entry.line, warnings, "layer、sourceRoot 與 sourceRef 不一致");
    return undefined;
  }

  const sourceRecord = stringValue(record.sourceRecord);
  const sha256 = stringValue(record.sha256);
  const note = stringValue(record.note);
  const mapping: MappingRecord = {
    entity,
    layer,
    sourceRoot,
    sourceId,
    targetId,
    sourceRef,
  };
  if (entity === "raw") {
    if (sha256 === undefined || !SHA256.test(sha256)) {
      invalid("INVALID_MAPPING", entry.file, entry.line, warnings, "raw mapping 需要 sha256");
      return undefined;
    }
    if (sourceRecord !== undefined) {
      invalid("INVALID_MAPPING", entry.file, entry.line, warnings, "raw mapping 不能有 sourceRecord");
      return undefined;
    }
    mapping.sha256 = sha256;
  } else {
    if (sourceRecord === undefined || sourceRecord === "") {
      invalid("INVALID_MAPPING", entry.file, entry.line, warnings, "非 raw mapping 需要 sourceRecord");
      return undefined;
    }
    mapping.sourceRecord = sourceRecord;
  }
  if (note !== undefined) mapping.note = note;
  return mapping;
}

function isInsidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function packageRealRoot(packageDir: string): string {
  try {
    return realpathSync(packageDir);
  } catch {
    return resolve(packageDir);
  }
}

function inspectPackageDirectory(
  packageDir: string,
  absolute: string,
  label: string,
  warnings: WarningCollector,
): "safe" | "symlink" | "missing" | "not-directory" {
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return "missing";
  }
  if (stats.isSymbolicLink()) {
    warnings.add(`SYMLINK_SKIPPED ${label}`);
    return "symlink";
  }
  if (!stats.isDirectory()) return "not-directory";
  try {
    if (!isInsidePath(packageRealRoot(packageDir), realpathSync(absolute))) {
      warnings.add(`SYMLINK_SKIPPED ${label}`);
      return "symlink";
    }
  } catch {
    warnings.add(`SYMLINK_SKIPPED ${label}`);
    return "symlink";
  }
  return "safe";
}

function inspectPackagePath(
  packageDir: string,
  relativePath: string,
): "safe" | "symlink" | "missing" | "not-file" {
  let current = resolve(packageDir);
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "symlink";
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return "missing";
    }
    if (stats.isSymbolicLink()) return "symlink";
  }
  try {
    const stats = lstatSync(current);
    if (!stats.isFile()) return "not-file";
    if (!isInsidePath(packageRealRoot(packageDir), realpathSync(current))) return "symlink";
  } catch {
    return "missing";
  }
  return "safe";
}

function inspectKnowledgeFile(
  packageDir: string,
  relativePath: string,
  warnings: WarningCollector,
): "safe" | "symlink" | "missing" | "not-file" {
  const state = inspectPackagePath(packageDir, relativePath);
  if (state === "symlink") {
    warnings.add(`KNOWLEDGE_SYMLINK_SKIPPED ${relativePath}`);
  }
  return state;
}

function readRawFiles(
  packageDir: string,
  warnings: WarningCollector,
): RawFile[] {
  const rawRoot = join(packageDir, "raw");
  const rootState = inspectPackageDirectory(packageDir, rawRoot, "raw", warnings);
  if (rootState === "missing" || rootState === "not-directory") {
    throw new ImportError("CORE_DIRECTORY_MISSING", "缺少核心資料夾：raw/");
  }
  if (rootState !== "safe") return [];

  const files: RawFile[] = [];
  for (const layer of ["project", "global"] as const) {
    const layerRoot = join(rawRoot, layer);
    const state = inspectPackageDirectory(
      packageDir,
      layerRoot,
      `raw/${layer}`,
      warnings,
    );
    if (state === "missing" || state === "not-directory") {
      throw new ImportError("CORE_DIRECTORY_MISSING", `缺少核心資料夾：raw/${layer}/`);
    }
    if (state !== "safe") continue;
    collectRaw(layerRoot, "", layer, files, warnings);
  }
  files.sort((left, right) => {
    const layerOrder = left.layer.localeCompare(right.layer);
    return layerOrder !== 0 ? layerOrder : left.path.localeCompare(right.path);
  });
  return files;
}

function collectRaw(
  root: string,
  prefix: string,
  layer: Layer,
  files: RawFile[],
  warnings: WarningCollector,
): void {
  const directory = prefix === "" ? root : join(root, prefix);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      warnings.add(`SYMLINK_SKIPPED raw/${layer}/${relative}`);
      continue;
    }
    if (entry.isDirectory()) {
      collectRaw(root, relative, layer, files, warnings);
      continue;
    }
    if (!entry.isFile()) {
      warnings.add(`UNSUPPORTED_ENTRY raw/${layer}/${relative}`);
      continue;
    }
    files.push({ layer, path: relative });
  }
}

function readKnowledgeBodies(
  packageDir: string,
  entries: Array<{ file: string; line: number; raw: RawKnowledge }>,
  warnings: WarningCollector,
): KnowledgeInput[] {
  const result: KnowledgeInput[] = [];
  for (const { file, line, raw } of entries) {
    const versions: KnowledgeVersionBody[] = [];
    for (const version of raw.rawVersions) {
      const state = inspectKnowledgeFile(packageDir, version.path, warnings);
      if (state === "symlink") continue;
      if (state === "missing" || state === "not-file") {
        warnings.add(`KNOWLEDGE_FILE_MISSING ${file} 第 ${line} 行：${version.path}`);
        continue;
      }
      const absolute = join(packageDir, version.path);
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
      } catch {
        warnings.add(`KNOWLEDGE_FILE_MISSING ${file} 第 ${line} 行：${version.path}`);
        continue;
      }
      const actualHash = sha256Bytes(bytes);
      if (actualHash !== version.sha256 || bytes.byteLength !== version.bytes) {
        warnings.add(`KNOWLEDGE_HASH_MISMATCH ${file} 第 ${line} 行：${version.path}`);
      }
      versions.push({ version: version.version, body: bytes.toString("utf8") });
    }
    if (versions.length === 0) {
      warnings.add(`KNOWLEDGE_NO_VERSIONS ${file} 第 ${line} 行：${raw.record.knowledgeId}`);
      continue;
    }
    const chosenCurrent = versions.some(
      (version) => version.version === raw.record.currentVersion,
    )
      ? raw.record.currentVersion
      : Math.max(...versions.map((version) => version.version));
    const record: KnowledgeRecord = {
      ...raw.record,
      currentVersion: chosenCurrent,
      versions: versions.map((version) => {
        const bodyBytes = Buffer.from(version.body, "utf8");
        return {
          version: version.version,
          path: `knowledge/files/${raw.record.knowledgeId}/v${version.version}.md`,
          sha256: sha256Bytes(bodyBytes),
          bytes: bodyBytes.byteLength,
        };
      }),
    };
    result.push({ record, versions });
  }
  return result;
}

function compareLayout(
  manifest: Manifest,
  counts: {
    work: number;
    events: number;
    evidence: number;
    signals: number;
    knowledge: number;
    knowledgeVersions: number;
    mapping: number;
    raw: number;
    rawProject: number;
    rawGlobal: number;
  },
  warnings: WarningCollector,
): void {
  const pairs: Array<[string, number, number]> = [
    ["work", manifest.layout.work.records, counts.work],
    ["events", manifest.layout.events.records, counts.events],
    ["evidence", manifest.layout.evidence.records, counts.evidence],
    ["signals", manifest.layout.signals.records, counts.signals],
    ["knowledge", manifest.layout.knowledge.entries, counts.knowledge],
    ["knowledgeFiles", manifest.layout.knowledge.files, counts.knowledgeVersions],
    ["mapping", manifest.layout.mapping.records, counts.mapping],
    ["raw", manifest.layout.raw.files, counts.raw],
    ["rawProjectFiles", manifest.layout.raw.projectFiles, counts.rawProject],
    ["rawGlobalFiles", manifest.layout.raw.globalFiles, counts.rawGlobal],
  ];
  for (const [label, declared, actual] of pairs) {
    if (declared !== actual) {
      warnings.add(`LAYOUT_COUNT_MISMATCH ${label}：manifest ${declared}，實際 ${actual}`);
    }
  }
}

export interface ReadPackageResult {
  contents: PackageContents;
  counts: {
    work: number;
    events: number;
    evidence: number;
    signals: number;
    knowledge: number;
    knowledgeVersions: number;
    mapping: number;
    raw: number;
    rawProject: number;
    rawGlobal: number;
  };
}

/** 讀取並寬容解析整個套件；核心檔案缺失才丟錯，其餘問題只記警告。 */
function readCoreJsonLines(
  packageDir: string,
  relative: string,
  warnings: WarningCollector,
): JsonLineEntry[] {
  const state = inspectPackagePath(packageDir, relative);
  if (state === "symlink") {
    warnings.add(`CORE_FILE_SYMLINK_SKIPPED ${relative}`);
    return [];
  }
  if (state === "missing" || state === "not-file") {
    throw new ImportError("CORE_FILE_MISSING", `缺少核心檔案：${relative}`);
  }
  return readJsonLines(join(packageDir, relative), relative, warnings);
}

export function readPackage(packageDir: string, warnings: WarningCollector): ReadPackageResult {
  const root = resolve(packageDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ImportError("PACKAGE_NOT_FOUND", `找不到匯出包資料夾：${root}`);
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!TOP_LEVEL.has(entry.name)) {
      warnings.add(`UNKNOWN_TOP_LEVEL_ENTRY ${entry.name}`);
    }
  }

  const manifestState = inspectPackagePath(root, "manifest.json");
  if (manifestState === "symlink") {
    throw new ImportError(
      "MANIFEST_SYMLINK",
      `manifest.json 是符號連結或指向套件外，拒絕讀取：${root}`,
    );
  }
  if (manifestState !== "safe") {
    throw new ImportError("MANIFEST_MISSING", `缺少 manifest.json：${root}`);
  }
  const manifest = validateManifest(readJsonFile(join(root, "manifest.json")), warnings);

  const workEntries = readCoreJsonLines(root, "work.jsonl", warnings);
  const eventEntries = readCoreJsonLines(root, "events.jsonl", warnings);
  const evidenceEntries = readCoreJsonLines(root, "evidence.jsonl", warnings);
  const signalEntries = readCoreJsonLines(root, "signals.jsonl", warnings);
  const knowledgeEntries = readCoreJsonLines(root, "knowledge/index.jsonl", warnings);
  const mappingEntries = readCoreJsonLines(root, "mapping.jsonl", warnings);

  const work: WorkRecord[] = [];
  const workIds = new Set<string>();
  for (const entry of workEntries) {
    const record = normalizeWork(entry, warnings);
    if (record === undefined) continue;
    if (workIds.has(record.workId)) {
      warnings.add(`DUPLICATE_ID ${entry.file} 第 ${entry.line} 行：${record.workId}`);
      continue;
    }
    workIds.add(record.workId);
    work.push(record);
  }

  const events: EventRecord[] = [];
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (const entry of eventEntries) {
    const record = normalizeEvent(entry, warnings);
    if (record === undefined) continue;
    if (eventIds.has(record.eventId)) {
      warnings.add(`DUPLICATE_ID ${entry.file} 第 ${entry.line} 行：${record.eventId}`);
      continue;
    }
    if (sequences.has(record.sequence)) {
      warnings.add(`DUPLICATE_SEQUENCE ${entry.file} 第 ${entry.line} 行：${record.sequence}`);
      continue;
    }
    eventIds.add(record.eventId);
    sequences.add(record.sequence);
    events.push(record);
  }

  const evidence: EvidenceRecord[] = [];
  const evidenceIds = new Set<string>();
  for (const entry of evidenceEntries) {
    const record = normalizeEvidence(entry, warnings);
    if (record === undefined) continue;
    if (evidenceIds.has(record.evidenceId)) {
      warnings.add(`DUPLICATE_ID ${entry.file} 第 ${entry.line} 行：${record.evidenceId}`);
      continue;
    }
    evidenceIds.add(record.evidenceId);
    evidence.push(record);
  }

  const signals: SignalRecord[] = [];
  const signalIds = new Set<string>();
  for (const entry of signalEntries) {
    const record = normalizeSignal(entry, warnings);
    if (record === undefined) continue;
    if (signalIds.has(record.signalId)) {
      warnings.add(`DUPLICATE_ID ${entry.file} 第 ${entry.line} 行：${record.signalId}`);
      continue;
    }
    signalIds.add(record.signalId);
    signals.push(record);
  }

  const rawKnowledge: Array<{ file: string; line: number; raw: RawKnowledge }> = [];
  const knowledgeIds = new Set<string>();
  for (const entry of knowledgeEntries) {
    const raw = normalizeKnowledge(entry, warnings);
    if (raw === undefined) continue;
    if (knowledgeIds.has(raw.record.knowledgeId)) {
      warnings.add(`DUPLICATE_ID ${entry.file} 第 ${entry.line} 行：${raw.record.knowledgeId}`);
      continue;
    }
    knowledgeIds.add(raw.record.knowledgeId);
    rawKnowledge.push({ file: entry.file, line: entry.line, raw });
  }
  const knowledge = readKnowledgeBodies(root, rawKnowledge, warnings);
  for (const entry of knowledge) {
    if (!manifest.source.layers.includes(entry.record.layer)) {
      warnings.add(
        `SOURCE_LAYER_MISMATCH knowledge/${entry.record.knowledgeId}：manifest 沒有 ${entry.record.layer}`,
      );
    }
  }

  const mapping: MappingRecord[] = [];
  const mappingKeys = new Set<string>();
  for (const entry of mappingEntries) {
    const record = normalizeMapping(entry, warnings);
    if (record === undefined) continue;
    const key = `${record.entity}\u0000${record.layer}\u0000${record.sourceId}`;
    if (mappingKeys.has(key)) {
      warnings.add(`DUPLICATE_MAPPING ${entry.file} 第 ${entry.line} 行：${record.sourceId}`);
      continue;
    }
    mappingKeys.add(key);
    mapping.push(record);
  }

  const raw = readRawFiles(root, warnings);
  const counts = {
    work: work.length,
    events: events.length,
    evidence: evidence.length,
    signals: signals.length,
    knowledge: knowledge.length,
    knowledgeVersions: knowledge.reduce((total, entry) => total + entry.versions.length, 0),
    mapping: mapping.length,
    raw: raw.length,
    rawProject: raw.filter((file) => file.layer === "project").length,
    rawGlobal: raw.filter((file) => file.layer === "global").length,
  };
  compareLayout(manifest, counts, warnings);

  return {
    contents: {
      root,
      manifest,
      work,
      events,
      evidence,
      signals,
      knowledge,
      mapping,
      raw,
    },
    counts,
  };
}

export type { MappingEntity };
