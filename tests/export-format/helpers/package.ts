import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { validateManifestSchema, validateRecordSchema } from "./schemas";
import type {
  EvidenceRecord,
  EventRecord,
  KnowledgeRecord,
  Manifest,
  MappingRecord,
  RecordPart,
  SignalRecord,
  WorkRecord,
} from "./types";
import { canonicalJson, compareStrings } from "./writer";

const EXPECTED_TOP_LEVEL = new Set([
  "manifest.json",
  "work.jsonl",
  "events.jsonl",
  "evidence.jsonl",
  "signals.jsonl",
  "knowledge",
  "mapping.jsonl",
  "raw",
]);

const TOP_LEVEL_DIRECTORIES = new Set(["knowledge", "raw"]);

const TOP_LEVEL_FILES = new Set([
  "manifest.json",
  "work.jsonl",
  "events.jsonl",
  "evidence.jsonl",
  "signals.jsonl",
  "mapping.jsonl",
]);

const RAW_LAYERS = ["project", "global"] as const;

const TIMESTAMP_KEY = new RegExp(
  "^(createdAt|updatedAt|generatedAt|exportedAt|modifiedAt|created_at|updated_at|generated_at|exported_at|verified_at|verifiedAt|timestamp|exportTime)$",
  "i",
);

const RECORD_FILE: Record<RecordPart, string> = {
  work: "work.jsonl",
  events: "events.jsonl",
  evidence: "evidence.jsonl",
  signals: "signals.jsonl",
  knowledge: "knowledge/index.jsonl",
  mapping: "mapping.jsonl",
};

export class PackageValidationError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "PackageValidationError";
    this.code = code;
    this.details = details;
  }
}

export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new PackageValidationError("FILE_UNREADABLE", `無法讀取 ${path}`, [String(error)]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PackageValidationError("JSON_INVALID", `${path} 不是合法 JSON`, [String(error)]);
  }
}

export function readJsonl(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new PackageValidationError("FILE_UNREADABLE", `無法讀取 ${path}`, [String(error)]);
  }
  if (text === "") return [];
  if (!text.endsWith("\n")) {
    throw new PackageValidationError("JSONL_INVALID", `${path} 的最後一行缺少換行`);
  }
  const lines = text.slice(0, -1).split("\n");
  const records: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      throw new PackageValidationError("JSONL_INVALID", `${path} 第 ${index + 1} 行是空行`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new PackageValidationError("JSONL_INVALID", `${path} 第 ${index + 1} 行不是合法 JSON`, [
        String(error),
      ]);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PackageValidationError(
        "JSONL_INVALID",
        `${path} 第 ${index + 1} 行必須是 JSON 物件`,
      );
    }
    records.push(parsed);
  }
  return records;
}

function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    compareStrings(left.name, right.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new PackageValidationError("SYMLINK_NOT_ALLOWED", `不允許符號連結：${prefix}${entry.name}`);
    }
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
      continue;
    }
    if (!entry.isFile()) {
      throw new PackageValidationError("UNSUPPORTED_ENTRY", `不支援的檔案類型：${relative}`);
    }
    files.push(relative);
  }
  return files;
}

function assertUnique(values: readonly string[], code: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PackageValidationError(code, `${label} 重複：${value}`);
    }
    seen.add(value);
  }
}

function assertSchema(part: RecordPart, records: readonly unknown[], file: string): void {
  for (const [index, record] of records.entries()) {
    const errors = validateRecordSchema(part, record);
    if (errors.length > 0) {
      throw new PackageValidationError(
        "SCHEMA_INVALID",
        `${file} 第 ${index + 1} 行不符合 schema`,
        errors,
      );
    }
  }
}

function assertCanonicalJsonl(
  path: string,
  part: RecordPart,
  records: readonly unknown[],
): void {
  const text = readFileSync(path, "utf8");
  if (text === "") return;
  const lines = text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    const expected = canonicalJson(records[index]);
    if (line !== expected) {
      throw new PackageValidationError(
        "JSONL_NOT_CANONICAL",
        `${RECORD_FILE[part]} 第 ${index + 1} 行不是 canonical JSONL`,
        ["鍵必須依碼點排序、使用緊湊 JSON，且不留多餘空白"],
      );
    }
  }

  const keyOf = (record: unknown): string => {
    if (part === "events") {
      const event = record as EventRecord;
      return `${String(event.sequence).padStart(12, "0")}\u0000${event.eventId}`;
    }
    if (part === "work") return (record as WorkRecord).workId;
    if (part === "evidence") return (record as EvidenceRecord).evidenceId;
    if (part === "signals") return (record as SignalRecord).signalId;
    if (part === "knowledge") return (record as KnowledgeRecord).knowledgeId;
    const mapping = record as MappingRecord;
    return [mapping.entity, mapping.layer, mapping.sourceId, mapping.targetId].join("\u0000");
  };

  let previous = "";
  for (const [index, record] of records.entries()) {
    const current = keyOf(record);
    if (index > 0 && compareStrings(previous, current) > 0) {
      throw new PackageValidationError(
        "JSONL_NOT_CANONICAL",
        `${RECORD_FILE[part]} 第 ${index + 1} 行的記錄順序錯誤`,
        [`上一筆 ${previous}，這一筆 ${current}`],
      );
    }
    previous = current;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findTimestampKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      findTimestampKeys(item, `${path}[${index}]`, found);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (TIMESTAMP_KEY.test(key)) {
      found.push(childPath);
    }
    findTimestampKeys(child, childPath, found);
  }
}

function failOnTimestampKeys(part: RecordPart, records: readonly unknown[], file: string): void {
  const found: string[] = [];
  for (const [index, record] of records.entries()) {
    findTimestampKeys(record, `${file}[${index}]`, found);
  }
  if (found.length > 0) {
    throw new PackageValidationError(
      "TIMESTAMP_IN_CONTENT",
      "內容檔案含有時間戳欄位，時間戳只能放在 manifest",
      found,
    );
  }
}

function failWhenGenerationTimeLeaks(file: string, text: string, createdAt: string): void {
  if (text.includes(createdAt)) {
    throw new PackageValidationError(
      "TIMESTAMP_IN_CONTENT",
      `${file} 含有 manifest 的產生時間`,
      [createdAt],
    );
  }
}

function assertCreatedAtIsReal(manifest: Manifest): void {
  const parsed = new Date(manifest.createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== manifest.createdAt) {
    throw new PackageValidationError(
      "INVALID_TIMESTAMP",
      "manifest.createdAt 不是真實存在的 UTC 日期",
      [manifest.createdAt],
    );
  }
}

interface ValidatedKnowledgeFiles {
  count: number;
}

function validateKnowledgeDirectory(
  root: string,
  entries: readonly KnowledgeRecord[],
  manifest: Manifest,
): ValidatedKnowledgeFiles {
  const knowledgeDir = join(root, "knowledge");
  const knowledgeEntries = readdirSync(knowledgeDir, { withFileTypes: true });
  let indexSeen = false;
  let filesSeen = false;
  for (const entry of knowledgeEntries) {
    if (entry.isSymbolicLink()) {
      throw new PackageValidationError("SYMLINK_NOT_ALLOWED", `不允許符號連結：knowledge/${entry.name}`);
    }
    if (entry.name === "index.jsonl" && entry.isFile()) {
      indexSeen = true;
      continue;
    }
    if (entry.name === "files" && entry.isDirectory()) {
      filesSeen = true;
      continue;
    }
    throw new PackageValidationError(
      "KNOWLEDGE_LAYOUT_INVALID",
      `knowledge/ 只能有 index.jsonl 與 files/，發現 ${entry.name}`,
    );
  }
  if (!indexSeen || !filesSeen) {
    throw new PackageValidationError(
      "KNOWLEDGE_LAYOUT_INVALID",
      "knowledge/ 缺少 index.jsonl 或 files/",
    );
  }

  const filesRoot = join(knowledgeDir, "files");
  const knownIds = new Set(entries.map((entry) => entry.knowledgeId));
  const actualDirectories = readdirSync(filesRoot, { withFileTypes: true });
  for (const directory of actualDirectories) {
    if (directory.isSymbolicLink()) {
      throw new PackageValidationError(
        "SYMLINK_NOT_ALLOWED",
        `不允許符號連結：knowledge/files/${directory.name}`,
      );
    }
    if (!directory.isDirectory() || !knownIds.has(directory.name)) {
      throw new PackageValidationError(
        "KNOWLEDGE_LAYOUT_INVALID",
        `knowledge/files/ 有未登錄的項目：${directory.name}`,
      );
    }
  }

  let fileCount = 0;
  for (const entry of entries) {
    const seenVersions = new Set<number>();
    for (const version of entry.versions) {
      if (seenVersions.has(version.version)) {
        throw new PackageValidationError(
          "KNOWLEDGE_VERSION_DUPLICATE",
          `${entry.knowledgeId} 的版本 ${version.version} 重複`,
        );
      }
      seenVersions.add(version.version);
    }
    if (!seenVersions.has(entry.currentVersion)) {
      throw new PackageValidationError(
        "KNOWLEDGE_CURRENT_VERSION_MISSING",
        `${entry.knowledgeId} 的 currentVersion ${entry.currentVersion} 不在 versions 內`,
      );
    }

    const entryDir = join(filesRoot, entry.knowledgeId);
    if (!existsSync(entryDir) || !statSync(entryDir).isDirectory()) {
      throw new PackageValidationError(
        "KNOWLEDGE_FILE_MISSING",
        `缺少知識項目資料夾：knowledge/files/${entry.knowledgeId}`,
      );
    }

    const actualNames = new Set(
      readdirSync(entryDir, { withFileTypes: true }).map((file) => file.name),
    );
    for (const version of entry.versions) {
      const expectedName = `v${version.version}.md`;
      if (!actualNames.has(expectedName)) {
        throw new PackageValidationError(
          "KNOWLEDGE_FILE_MISSING",
          `缺少知識版本檔案：knowledge/files/${entry.knowledgeId}/${expectedName}`,
        );
      }
      const expectedPath = `knowledge/files/${entry.knowledgeId}/v${version.version}.md`;
      if (version.path !== expectedPath) {
        throw new PackageValidationError(
          "KNOWLEDGE_LAYOUT_INVALID",
          `${entry.knowledgeId} 的版本路徑應為 ${expectedPath}`,
          [version.path],
        );
      }
      const absolutePath = join(root, version.path);
      failWhenGenerationTimeLeaks(
        version.path,
        readFileSync(absolutePath, "utf8"),
        manifest.createdAt,
      );
      const bytes = readFileSync(absolutePath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== version.sha256 || bytes.byteLength !== version.bytes) {
        throw new PackageValidationError(
          "KNOWLEDGE_HASH_MISMATCH",
          `${version.path} 的 sha256 或 bytes 與 index 不符`,
        );
      }
      fileCount += 1;
      actualNames.delete(expectedName);
    }
    if (actualNames.size > 0) {
      throw new PackageValidationError(
        "KNOWLEDGE_LAYOUT_INVALID",
        `${entry.knowledgeId} 有未登錄的版本檔案`,
        [...actualNames].sort(compareStrings),
      );
    }
  }

  return { count: fileCount };
}

function inspectRawLayers(root: string): {
  files: string[];
  projectFiles: number;
  globalFiles: number;
} {
  const rawRoot = join(root, "raw");
  const entries = readdirSync(rawRoot, { withFileTypes: true });
  const present = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new PackageValidationError("SYMLINK_NOT_ALLOWED", `不允許符號連結：raw/${entry.name}`);
    }
    if (!entry.isDirectory() || !RAW_LAYERS.includes(entry.name as (typeof RAW_LAYERS)[number])) {
      throw new PackageValidationError(
        "RAW_LAYER_INVALID",
        `raw/ 只能有 project/ 與 global/，發現 ${entry.name}`,
      );
    }
    present.add(entry.name);
  }
  for (const layer of RAW_LAYERS) {
    if (!present.has(layer)) {
      throw new PackageValidationError("RAW_LAYER_MISSING", `raw/${layer}/ 不存在`);
    }
  }

  const files = listFiles(rawRoot);
  for (const file of files) {
    const [layer] = file.split("/");
    if (layer !== "project" && layer !== "global") {
      throw new PackageValidationError("RAW_LAYER_INVALID", `raw 檔案不在分層資料夾：${file}`);
    }
  }
  return {
    files,
    projectFiles: files.filter((file) => file.startsWith("project/")).length,
    globalFiles: files.filter((file) => file.startsWith("global/")).length,
  };
}

function expectedSourceRoot(layer: "project" | "global"): string {
  return layer === "project" ? "raw/project" : "raw/global";
}

function validateRawDirectory(
  root: string,
  rawFiles: readonly string[],
  mappings: readonly MappingRecord[],
  manifest: Manifest,
): void {
  const rawTargets = mappings.filter((mapping) => mapping.entity === "raw");
  const byTarget = new Map<string, MappingRecord>();
  for (const mapping of rawTargets) {
    if (byTarget.has(mapping.targetId)) {
      throw new PackageValidationError(
        "RAW_MAPPING_DUPLICATE",
        `raw 檔案的對應重複：${mapping.targetId}`,
      );
    }
    byTarget.set(mapping.targetId, mapping);
  }

  for (const file of rawFiles) {
    const targetId = `raw/${file}`;
    const mapping = byTarget.get(targetId);
    if (mapping === undefined) {
      throw new PackageValidationError("RAW_MAPPING_MISSING", `raw 檔案缺少 mapping：${targetId}`);
    }
    if (mapping.sourceRef !== targetId) {
      throw new PackageValidationError(
        "MAPPING_RAW_TARGET_MISMATCH",
        `${targetId} 的 sourceRef 必須等於 targetId`,
      );
    }
    if (mapping.sourceRoot !== expectedSourceRoot(mapping.layer)) {
      throw new PackageValidationError(
        "MAPPING_ROOT_MISMATCH",
        `${targetId} 的 sourceRoot 與 layer 不一致`,
      );
    }
    if (mapping.sourceRecord !== undefined) {
      throw new PackageValidationError(
        "MAPPING_RAW_SOURCE_RECORD_FORBIDDEN",
        `${targetId} 是 raw 檔案，不應該有 sourceRecord`,
      );
    }
    const hash = sha256File(join(root, targetId));
    if (mapping.sha256 !== hash) {
      throw new PackageValidationError(
        "RAW_HASH_MISMATCH",
        `${targetId} 的 sha256 與 mapping 不符`,
      );
    }
  }

  for (const targetId of byTarget.keys()) {
    if (!rawFiles.includes(targetId.slice("raw/".length))) {
      throw new PackageValidationError("RAW_FILE_MISSING", `mapping 指向不存在的 raw 檔案：${targetId}`);
    }
  }

  if (manifest.layout.raw.files !== rawFiles.length) {
    throw new PackageValidationError(
      "COUNT_MISMATCH",
      `manifest 記載 ${manifest.layout.raw.files} 個 raw 檔案，實際有 ${rawFiles.length} 個`,
    );
  }
}

function assertAcceptanceResults(work: readonly WorkRecord[]): void {
  for (const record of work) {
    if (record.acceptanceResults === undefined) continue;
    const acceptance = record.acceptance;
    if (acceptance === undefined) {
      throw new PackageValidationError(
        "ACCEPTANCE_RESULTS_MISMATCH",
        `${record.workId} 有 acceptanceResults 但沒有 acceptance`,
      );
    }
    const items = record.acceptanceResults.items;
    if (
      items.length !== acceptance.length ||
      items.some((item, index) => item.criterion !== acceptance[index])
    ) {
      throw new PackageValidationError(
        "ACCEPTANCE_RESULTS_MISMATCH",
        `${record.workId} 的 acceptanceResults 與 acceptance 沒有逐項對齊`,
      );
    }
  }
}

function validateMappings(
  root: string,
  mappings: readonly MappingRecord[],
  knowledge: readonly KnowledgeRecord[],
): void {
  const knownKnowledge = new Map(knowledge.map((entry) => [entry.knowledgeId, entry]));
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const key = `${mapping.entity}\u0000${mapping.layer}\u0000${mapping.sourceId}`;
    if (seen.has(key)) {
      throw new PackageValidationError(
        "DUPLICATE_MAPPING",
        `mapping 重複：${mapping.entity} / ${mapping.layer} / ${mapping.sourceId}`,
      );
    }
    seen.add(key);

    const rootPath = expectedSourceRoot(mapping.layer);
    if (mapping.sourceRoot !== rootPath) {
      throw new PackageValidationError(
        "MAPPING_ROOT_MISMATCH",
        `${mapping.entity} mapping 的 sourceRoot 與 layer 不一致`,
      );
    }
    if (!mapping.sourceRef.startsWith(`${rootPath}/`)) {
      throw new PackageValidationError(
        "MAPPING_SOURCE_REF_INVALID",
        `${mapping.entity} mapping 的 sourceRef 不在 ${rootPath} 內`,
      );
    }
    const sourceRefPath = join(root, mapping.sourceRef);
    if (!existsSync(sourceRefPath) || !statSync(sourceRefPath).isFile()) {
      throw new PackageValidationError(
        "MAPPING_SOURCE_REF_MISSING",
        `mapping 的 sourceRef 不存在或不是檔案：${mapping.sourceRef}`,
      );
    }
    if (mapping.entity === "raw") {
      if (mapping.sourceRecord !== undefined) {
        throw new PackageValidationError(
          "MAPPING_RAW_SOURCE_RECORD_FORBIDDEN",
          "raw mapping 不能有 sourceRecord",
        );
      }
      const expectedSourceId = mapping.targetId.slice(`${rootPath}/`.length);
      if (mapping.sourceId !== expectedSourceId) {
        throw new PackageValidationError(
          "MAPPING_SOURCE_ID_MISMATCH",
          `raw mapping 的 sourceId 必須是層內相對路徑：${mapping.targetId}`,
        );
      }
    } else {
      if (mapping.sourceRecord === undefined) {
        throw new PackageValidationError(
          "MAPPING_SOURCE_RECORD_MISSING",
          `${mapping.entity} mapping 缺少 sourceRecord`,
        );
      }
      if (mapping.entity === "knowledge") {
        const entry = knownKnowledge.get(mapping.targetId);
        if (entry === undefined) {
          throw new PackageValidationError(
            "MAPPING_TARGET_MISSING",
            `knowledge mapping 指向不存在的知識項目：${mapping.targetId}`,
          );
        }
        if (entry.layer !== mapping.layer) {
          throw new PackageValidationError(
            "MAPPING_LAYER_MISMATCH",
            `knowledge mapping 的 layer 與知識項目不一致：${mapping.targetId}`,
          );
        }
      }
    }
  }
}

function validateEvidencePaths(root: string, evidence: readonly EvidenceRecord[]): void {
  for (const record of evidence) {
    if (record.path === undefined) continue;
    const evidencePath = join(root, record.path);
    if (!existsSync(evidencePath) || !statSync(evidencePath).isFile()) {
      throw new PackageValidationError(
        "EVIDENCE_PATH_MISSING",
        `evidence ${record.evidenceId} 的 path 不存在或不是檔案：${record.path}`,
      );
    }
  }
}

function validateCounts(
  manifest: Manifest,
  counts: {
    work: number;
    events: number;
    evidence: number;
    signals: number;
    knowledge: number;
    knowledgeFiles: number;
    mapping: number;
    rawProjectFiles: number;
    rawGlobalFiles: number;
  },
): void {
  const expected: Array<[string, number, number]> = [
    ["work", manifest.layout.work.records, counts.work],
    ["events", manifest.layout.events.records, counts.events],
    ["evidence", manifest.layout.evidence.records, counts.evidence],
    ["signals", manifest.layout.signals.records, counts.signals],
    ["knowledge", manifest.layout.knowledge.entries, counts.knowledge],
    ["knowledgeFiles", manifest.layout.knowledge.files, counts.knowledgeFiles],
    ["mapping", manifest.layout.mapping.records, counts.mapping],
    ["rawProjectFiles", manifest.layout.raw.projectFiles, counts.rawProjectFiles],
    ["rawGlobalFiles", manifest.layout.raw.globalFiles, counts.rawGlobalFiles],
  ];
  for (const [label, declared, actual] of expected) {
    if (declared !== actual) {
      throw new PackageValidationError(
        "COUNT_MISMATCH",
        `manifest 記載 ${label} 為 ${declared}，實際為 ${actual}`,
      );
    }
  }
}

export interface ValidatedPackage {
  root: string;
  manifest: Manifest;
  work: WorkRecord[];
  events: EventRecord[];
  evidence: EvidenceRecord[];
  signals: SignalRecord[];
  knowledge: KnowledgeRecord[];
  mapping: MappingRecord[];
  rawFiles: string[];
}

export function validatePackage(root: string): ValidatedPackage {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new PackageValidationError("PACKAGE_NOT_FOUND", `找不到匯出包資料夾：${root}`);
  }

  const topLevel = readdirSync(root, { withFileTypes: true });
  const actualTopLevel = new Set(topLevel.map((entry) => entry.name));
  for (const entry of topLevel) {
    if (entry.isSymbolicLink()) {
      throw new PackageValidationError("SYMLINK_NOT_ALLOWED", `不允許符號連結：${entry.name}`);
    }
    if (!EXPECTED_TOP_LEVEL.has(entry.name)) {
      throw new PackageValidationError("UNKNOWN_TOP_LEVEL_ENTRY", `未知的頂層項目：${entry.name}`);
    }
    const shouldBeDirectory = TOP_LEVEL_DIRECTORIES.has(entry.name);
    if (shouldBeDirectory && !entry.isDirectory()) {
      throw new PackageValidationError("TOP_LEVEL_TYPE_MISMATCH", `${entry.name} 必須是資料夾`);
    }
    if (TOP_LEVEL_FILES.has(entry.name) && !entry.isFile()) {
      throw new PackageValidationError("TOP_LEVEL_TYPE_MISMATCH", `${entry.name} 必須是檔案`);
    }
  }
  for (const expected of EXPECTED_TOP_LEVEL) {
    if (!actualTopLevel.has(expected)) {
      throw new PackageValidationError("MISSING_TOP_LEVEL_ENTRY", `缺少頂層項目：${expected}`);
    }
  }

  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new PackageValidationError("MANIFEST_MISSING", "缺少 manifest.json");
  }
  const manifestValue = readJsonFile(manifestPath);
  const manifestErrors = validateManifestSchema(manifestValue);
  if (manifestErrors.length > 0) {
    throw new PackageValidationError("MANIFEST_INVALID", "manifest.json 不符合 schema", manifestErrors);
  }
  const manifest = manifestValue as Manifest;
  assertCreatedAtIsReal(manifest);

  const records: Record<RecordPart, unknown[]> = {
    work: readJsonl(join(root, RECORD_FILE.work)),
    events: readJsonl(join(root, RECORD_FILE.events)),
    evidence: readJsonl(join(root, RECORD_FILE.evidence)),
    signals: readJsonl(join(root, RECORD_FILE.signals)),
    knowledge: readJsonl(join(root, RECORD_FILE.knowledge)),
    mapping: readJsonl(join(root, RECORD_FILE.mapping)),
  };

  for (const part of Object.keys(records) as RecordPart[]) {
    assertCanonicalJsonl(join(root, RECORD_FILE[part]), part, records[part]);
    failOnTimestampKeys(part, records[part], RECORD_FILE[part]);
    assertSchema(part, records[part], RECORD_FILE[part]);
    const text = readFileSync(join(root, RECORD_FILE[part]), "utf8");
    failWhenGenerationTimeLeaks(RECORD_FILE[part], text, manifest.createdAt);
  }

  const work = records.work as WorkRecord[];
  const events = records.events as EventRecord[];
  const evidence = records.evidence as EvidenceRecord[];
  const signals = records.signals as SignalRecord[];
  const knowledge = records.knowledge as KnowledgeRecord[];
  const mapping = records.mapping as MappingRecord[];

  assertUnique(work.map((record) => record.workId), "DUPLICATE_ID", "workId");
  assertUnique(events.map((record) => record.eventId), "DUPLICATE_ID", "eventId");
  assertUnique(events.map((record) => String(record.sequence)), "DUPLICATE_SEQUENCE", "event sequence");
  assertUnique(evidence.map((record) => record.evidenceId), "DUPLICATE_ID", "evidenceId");
  assertUnique(signals.map((record) => record.signalId), "DUPLICATE_ID", "signalId");
  assertUnique(knowledge.map((record) => record.knowledgeId), "DUPLICATE_ID", "knowledgeId");

  assertAcceptanceResults(work);

  const knowledgeFiles = validateKnowledgeDirectory(root, knowledge, manifest);
  const raw = inspectRawLayers(root);
  validateRawDirectory(root, raw.files, mapping, manifest);
  validateMappings(root, mapping, knowledge);
  validateEvidencePaths(root, evidence);

  const sourceLayers = new Set(manifest.source.layers);
  for (const knowledgeEntry of knowledge) {
    if (!sourceLayers.has(knowledgeEntry.layer)) {
      throw new PackageValidationError(
        "SOURCE_LAYER_MISMATCH",
        `manifest.source.layers 沒有知識項目的層 ${knowledgeEntry.layer}`,
      );
    }
  }
  for (const mappingRecord of mapping) {
    if (!sourceLayers.has(mappingRecord.layer)) {
      throw new PackageValidationError(
        "SOURCE_LAYER_MISMATCH",
        `manifest.source.layers 沒有 ${mappingRecord.layer}`,
      );
    }
  }

  validateCounts(manifest, {
    work: work.length,
    events: events.length,
    evidence: evidence.length,
    signals: signals.length,
    knowledge: knowledge.length,
    knowledgeFiles: knowledgeFiles.count,
    mapping: mapping.length,
    rawProjectFiles: raw.projectFiles,
    rawGlobalFiles: raw.globalFiles,
  });

  return { root, manifest, work, events, evidence, signals, knowledge, mapping, rawFiles: raw.files };
}
