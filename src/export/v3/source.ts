import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { canonicalizePath } from "../../shared/paths.ts";
import { compareCodePoints, sha256Bytes, sha256Text } from "./canonical.ts";
import { ExportV3Error } from "./errors.ts";
import type { Layer } from "./types.ts";
import type { WarningCollector } from "./warnings.ts";

const TASKS_REGISTRY_FIELDS = new Set([
  "version",
  "projectId",
  "projectPath",
  "activeTaskIds",
  "taskCursor",
  "tasks",
]);

const PLANS_REGISTRY_FIELDS = new Set([
  "version",
  "projectId",
  "projectPath",
  "activePlanIds",
  "planCursor",
  "plans",
]);

export interface LegacyEntry {
  key: string;
  record: Record<string, unknown>;
}

export interface SourceFileEntry {
  layer: Layer;
  relativePath: string;
  safePath: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
}

export interface JsonLineEntry {
  layer: Layer;
  lineIndex: number;
  relativePath: string;
  safePath: string;
  record: Record<string, unknown>;
}

export interface MemoryTopicSource {
  layer: Layer;
  relativePath: string;
  safePath: string;
  stem: string;
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

export interface SkillDraftSource {
  layer: Layer;
  relativePath: string;
  safePath: string;
  name: string;
  data: Record<string, unknown>;
  body: string;
}

export interface SourceData {
  projectRoot: string;
  globalRoot?: string;
  projectId: string;
  registryVersion?: string;
  tasksRegistry: Record<string, unknown>;
  plansRegistry?: Record<string, unknown>;
  tasks: LegacyEntry[];
  plans: LegacyEntry[];
  audit: JsonLineEntry[];
  memoryLogs: JsonLineEntry[];
  topics: MemoryTopicSource[];
  skills: SkillDraftSource[];
  files: SourceFileEntry[];
  warnings: WarningCollector;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `--project` 指向專案根目錄；也接受直接指向 `.ultrawork`。 */
export function resolveProjectSource(projectPath: string): string {
  const nested = join(projectPath, ".ultrawork");
  if (isDirectory(nested)) return nested;
  if (isDirectory(projectPath)) {
    const looksLikeSource =
      basename(projectPath) === ".ultrawork" ||
      isFile(join(projectPath, "tasks.json")) ||
      isFile(join(projectPath, "plans.json")) ||
      isDirectory(join(projectPath, "memory")) ||
      isDirectory(join(projectPath, "plans")) ||
      isFile(join(projectPath, "audit.jsonl"));
    if (looksLikeSource) return projectPath;
  }
  throw new ExportV3Error(
    "NOT_ULTRAWORK_SOURCE",
    `找不到可辨識的 ultrawork 來源：${projectPath}`,
  );
}

/**
 * `--global` 指向全域層根目錄（內容會原樣進 raw/global）。
 * 如果傳進來的是包含 `.ultrawork` 的全域設定資料夾，就自動往下一層。
 */
export function resolveGlobalSource(globalPath: string): string {
  if (!isDirectory(globalPath)) {
    throw new ExportV3Error("GLOBAL_SOURCE_NOT_FOUND", `找不到全域來源資料夾：${globalPath}`);
  }
  const nested = join(globalPath, ".ultrawork");
  return isDirectory(nested) ? nested : globalPath;
}

function readJsonFile(path: string, code: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ExportV3Error(code, `無法讀取 ${label}：${path}`, [String(error)]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ExportV3Error(code, `${label} 不是合法 JSON：${path}`, [String(error)]);
  }
}

function warnUnknownRegistryFields(
  root: Record<string, unknown>,
  known: ReadonlySet<string>,
  label: string,
  warnings: WarningCollector,
): void {
  for (const key of Object.keys(root)) {
    if (!known.has(key)) warnings.add(`UNMAPPED_REGISTRY_FIELD: ${label}.${key}`);
  }
}

/** 只有真的有內容的欄位才值得警告；空陣列、空物件、null 不算資料。 */
function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasMeaningfulValue);
  }
  return true;
}

interface RegistryRead {
  registry: Record<string, unknown>;
  entries: LegacyEntry[];
}

function readRegistry(
  path: string,
  label: string,
  tableField: "tasks" | "plans",
  idField: "taskId" | "planId",
  knownFields: ReadonlySet<string>,
  warnings: WarningCollector,
  required: boolean,
): RegistryRead | undefined {
  if (!isFile(path)) {
    if (required) {
      throw new ExportV3Error("TASKS_REGISTRY_MISSING", `缺少必要來源檔：${label}`);
    }
    return undefined;
  }
  const code = required ? "TASKS_REGISTRY_INVALID" : "PLANS_REGISTRY_INVALID";
  const parsed = readJsonFile(path, code, label);
  const registry = asRecord(parsed);
  if (registry === undefined) {
    throw new ExportV3Error(code, `${label} 的根必須是物件`);
  }
  warnUnknownRegistryFields(registry, knownFields, label, warnings);
  const table = asRecord(registry[tableField]);
  if (table === undefined) {
    throw new ExportV3Error(code, `${label} 缺少 ${tableField} 物件`);
  }
  const entries: LegacyEntry[] = [];
  for (const [key, value] of Object.entries(table)) {
    const record = asRecord(value);
    if (record === undefined) {
      warnings.add(`INVALID_RECORD: ${label} ${key} 不是物件`);
      continue;
    }
    const declared = asString(record[idField]);
    if (declared !== undefined && declared !== key) {
      warnings.add(`RECORD_ID_MISMATCH: ${label} ${key} 的 ${idField} 是 ${declared}`);
    }
    entries.push({ key, record });
  }
  return { registry, entries };
}

/** 舊 registry 的頂層與記錄欄位，用來找出未來新增、匯出器還不認得的欄位。 */
export const TASK_FIELDS = new Set([
  "taskId",
  "projectId",
  "projectPath",
  "title",
  "state",
  "owner",
  "priority",
  "dependsOn",
  "phase",
  "milestone",
  "planRef",
  "specRef",
  "indexRef",
  "archivingAt",
  "updatedAt",
  "history",
  "planId",
  "taskType",
  "parentTaskId",
  "subTaskIds",
  "blockedBy",
  "parallelGroup",
  "planStep",
  "acceptanceCriteria",
  "contentRef",
  "taskContentPath",
  "taskContentMode",
  "contentVersion",
  "risk",
  "acceptanceResults",
  "review",
]);

/**
 * 舊任務有、但 v1 沒有對應欄位的資料。它們原樣留在 raw/，
 * 匯出時要讓 manifest 能追蹤，不能安靜消失。
 */
export const TASK_RAW_ONLY_FIELDS = new Set([
  "phase",
  "milestone",
  "planRef",
  "specRef",
  "indexRef",
  "archivingAt",
  "taskType",
  "parentTaskId",
  "subTaskIds",
  "blockedBy",
  "parallelGroup",
  "planStep",
  "contentRef",
  "taskContentPath",
  "taskContentMode",
  "contentVersion",
]);

export const PLAN_FIELDS = new Set([
  "planId",
  "projectId",
  "projectPath",
  "title",
  "state",
  "owner",
  "priority",
  "createdAt",
  "updatedAt",
  "taskIds",
  "finishedTaskIds",
  "dependencyGraph",
  "history",
  "contentRef",
  "contentPath",
  "contentVersion",
  "completionTombstones",
]);

/** 舊計畫有、但 v1 沒有對應欄位的資料；這些只留在 raw/ 並記 warning。 */
export const PLAN_RAW_ONLY_FIELDS = new Set([
  "taskIds",
  "finishedTaskIds",
  "dependencyGraph",
  "completionTombstones",
  "contentRef",
  "contentPath",
  "contentVersion",
]);

interface RawFile {
  layer: Layer;
  relativePath: string;
  absolutePath: string;
}

function walkLayer(root: string, layer: Layer, warnings: WarningCollector): RawFile[] {
  const files: RawFile[] = [];
  const walk = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new ExportV3Error("SOURCE_UNREADABLE", `無法讀取來源資料夾：${directory}`, [String(error)]);
    }
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.add(`SYMLINK_SKIPPED: ${layer}/${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        warnings.add(`UNSUPPORTED_SOURCE_ENTRY: ${layer}/${relativePath}`);
        continue;
      }
      files.push({ layer, relativePath, absolutePath });
    }
  };
  walk(root, "");
  return files;
}

function sanitizeSegment(segment: string): string {
  let safe = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-");
  safe = safe.replace(/^-+/, "").replace(/-+$/, "");
  if (safe === "" || safe === "." || safe === "..") safe = "item";
  if (safe !== segment && !/^[A-Za-z0-9]/.test(safe)) safe = `item${safe.startsWith(".") ? safe : `-${safe}`}`;
  if (safe.length > 120) {
    const hash = sha256Text(segment).slice(0, 8);
    const lastDot = safe.lastIndexOf(".");
    const base = lastDot > 0 ? safe.slice(0, lastDot) : safe;
    const extension = lastDot > 0 ? safe.slice(lastDot) : "";
    safe = `${base.slice(0, 100)}-${hash}${extension.slice(0, 20)}`;
  }
  return safe;
}

function addHashSuffix(path: string, hash: string): string {
  const parts = path.split("/");
  const name = parts.pop() ?? "item";
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const extension = lastDot > 0 ? name.slice(lastDot) : "";
  parts.push(`${base}-${hash}${extension}`);
  return parts.join("/");
}

function sanitizeRelativePath(relativePath: string): string {
  const originalSegments = relativePath.split("/");
  const safeSegments = originalSegments.map(sanitizeSegment);
  const safePath = safeSegments.join("/");
  const changed = safeSegments.some((segment, index) => segment !== originalSegments[index]);
  return changed ? addHashSuffix(safePath, sha256Text(relativePath).slice(0, 8)) : safePath;
}

function limitPathLength(path: string): string {
  if (path.length <= 480) return path;
  const name = basename(path);
  const lastDot = name.lastIndexOf(".");
  const extension = lastDot > 0 ? name.slice(lastDot, lastDot + 20) : "";
  return `long/${sha256Text(path).slice(0, 16)}${extension}`;
}

function assignSafePaths(files: RawFile[]): Map<RawFile, string> {
  const result = new Map<RawFile, string>();
  const usedByLayer = new Map<Layer, Set<string>>();
  const sorted = [...files].sort((left, right) => {
    const layerOrder = compareCodePoints(left.layer, right.layer);
    return layerOrder !== 0
      ? layerOrder
      : compareCodePoints(left.relativePath, right.relativePath);
  });
  for (const file of sorted) {
    let used = usedByLayer.get(file.layer);
    if (used === undefined) {
      used = new Set<string>();
      usedByLayer.set(file.layer, used);
    }
    let candidate = limitPathLength(sanitizeRelativePath(file.relativePath));
    if (used.has(candidate)) {
      const hashed = addHashSuffix(candidate, sha256Text(file.relativePath).slice(0, 8));
      candidate = limitPathLength(hashed);
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = addHashSuffix(hashed, String(suffix));
        suffix += 1;
      }
    }
    used.add(candidate);
    result.set(file, candidate);
  }
  return result;
}

const KNOWN_RAW_ONLY_EXACT = new Set([
  "state.md",
  "comment-signal-baseline.json",
  ".lock",
  ".DS_Store",
]);

function isKnownRawOnly(relativePath: string): boolean {
  if (KNOWN_RAW_ONLY_EXACT.has(relativePath)) return true;
  if (relativePath === "memory/MEMORY.md") return true;
  if (relativePath.startsWith("cache/")) return true;
  if (relativePath.startsWith("plans/")) return true;
  if (relativePath.startsWith("skill-drafts/")) return true;
  return false;
}

function classifyFiles(files: readonly SourceFileEntry[], warnings: WarningCollector): void {
  for (const file of files) {
    const relativePath = file.relativePath;
    if (relativePath === "memory/usage.json") {
      warnings.add(`UNMAPPED_USAGE: ${file.layer}/memory/usage.json`);
      continue;
    }
    if (
      file.layer === "project" &&
      (relativePath === "tasks.json" || relativePath === "plans.json" || relativePath === "audit.jsonl")
    ) {
      continue;
    }
    if (relativePath === "memory/log.jsonl") continue;
    if (/^memory\/topics\/[^/]+\.md$/.test(relativePath)) continue;
    if (/^skill-drafts\/[^/]+\/SKILL\.md$/.test(relativePath)) continue;
    if (isKnownRawOnly(relativePath)) continue;
    if (/\/\.lock$/.test(relativePath) || relativePath.endsWith(".DS_Store")) continue;
    warnings.add(`UNMAPPED_SOURCE_FILE: ${file.layer}/${relativePath}`);
  }
}

function readJsonLines(
  file: SourceFileEntry | undefined,
  warnings: WarningCollector,
): JsonLineEntry[] {
  if (file === undefined) return [];
  let text: string;
  try {
    text = readFileSync(file.absolutePath, "utf8");
  } catch (error) {
    throw new ExportV3Error("SOURCE_UNREADABLE", `無法讀取 ${file.relativePath}`, [String(error)]);
  }
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const entries: JsonLineEntry[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      warnings.add(`INVALID_JSON_LINE: ${file.layer}/${file.relativePath} 第 ${lineIndex + 1} 行`);
      continue;
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      warnings.add(`INVALID_JSON_LINE: ${file.layer}/${file.relativePath} 第 ${lineIndex + 1} 行`);
      continue;
    }
    entries.push({
      layer: file.layer,
      lineIndex,
      relativePath: file.relativePath,
      safePath: file.safePath,
      record,
    });
  }
  return entries;
}

export interface FrontmatterParse {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatterValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => unquote(item)).filter((item) => item !== "");
  }
  return unquote(trimmed);
}

/** 解析 YAML frontmatter；不支援多行值，舊記憶的主題欄位都是單行。 */
export function parseFrontmatter(raw: string): FrontmatterParse {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (match === null) {
    return { data: {}, body: normalized, hasFrontmatter: false };
  }
  const data: Record<string, unknown> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const keyValue = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyValue === null) continue;
    data[keyValue[1]!] = parseFrontmatterValue(keyValue[2] ?? "");
  }
  return {
    data,
    body: normalized.slice(match[0].length),
    hasFrontmatter: true,
  };
}

export const TOPIC_FIELDS = new Set([
  "title",
  "description",
  "type",
  "pinned",
  "source",
  "created",
  "updated",
  "verified_at",
  "tags",
]);

function readTopics(
  files: readonly SourceFileEntry[],
  warnings: WarningCollector,
): MemoryTopicSource[] {
  const topics: MemoryTopicSource[] = [];
  const candidates = files
    .filter((file) => /^memory\/topics\/[^/]+\.md$/.test(file.relativePath))
    .sort((left, right) => {
      const leftRank = left.layer === "project" ? 0 : 1;
      const rightRank = right.layer === "project" ? 0 : 1;
      return leftRank !== rightRank
        ? leftRank - rightRank
        : compareCodePoints(left.relativePath, right.relativePath);
    });
  for (const file of candidates) {
    let raw: string;
    try {
      raw = readFileSync(file.absolutePath, "utf8");
    } catch (error) {
      throw new ExportV3Error("SOURCE_UNREADABLE", `無法讀取 ${file.relativePath}`, [String(error)]);
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed.hasFrontmatter) {
      warnings.add(`TOPIC_FRONTMATTER_MISSING: ${file.layer}/${file.relativePath}`);
    }
    for (const key of Object.keys(parsed.data)) {
      if (!TOPIC_FIELDS.has(key)) {
        warnings.add(`UNMAPPED_TOPIC_FIELD: ${file.layer}/${file.relativePath}.${key}`);
      }
    }
    const fileName = basename(file.relativePath);
    topics.push({
      layer: file.layer,
      relativePath: file.relativePath,
      safePath: file.safePath,
      stem: fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName,
      data: parsed.data,
      body: parsed.body,
      hasFrontmatter: parsed.hasFrontmatter,
    });
  }
  return topics;
}

export interface ReadSourceOptions {
  project: string;
  global?: string;
}

function readSkills(
  files: readonly SourceFileEntry[],
  warnings: WarningCollector,
): SkillDraftSource[] {
  const skills: SkillDraftSource[] = [];
  const candidates = files
    .filter((file) => /^skill-drafts\/[^/]+\/SKILL\.md$/.test(file.relativePath))
    .sort((left, right) => {
      const leftRank = left.layer === "project" ? 0 : 1;
      const rightRank = right.layer === "project" ? 0 : 1;
      return leftRank !== rightRank
        ? leftRank - rightRank
        : compareCodePoints(left.relativePath, right.relativePath);
    });
  for (const file of candidates) {
    let raw: string;
    try {
      raw = readFileSync(file.absolutePath, "utf8");
    } catch (error) {
      throw new ExportV3Error("SOURCE_UNREADABLE", `無法讀取 ${file.relativePath}`, [String(error)]);
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed.hasFrontmatter) {
      warnings.add(`SKILL_DRAFT_FRONTMATTER_MISSING: ${file.layer}/${file.relativePath}`);
    }
    const parts = file.relativePath.split("/");
    const name = parts[1] ?? "skill";
    skills.push({
      layer: file.layer,
      relativePath: file.relativePath,
      safePath: file.safePath,
      name,
      data: parsed.data,
      body: parsed.body,
    });
  }
  return skills;
}

/** 讀取來源層；只讀檔，不建立或修改任何來源路徑。 */
export function readSource(
  options: ReadSourceOptions,
  warnings: WarningCollector,
): SourceData {
  const projectRoot = resolveProjectSource(options.project);
  let globalRoot = options.global === undefined ? undefined : resolveGlobalSource(options.global);
  /**
   * 專案根目錄剛好就是全域設定資料夾時，同一個 .ultrawork 會被當成兩層各讀一次，
   * 匯出包會出現重複的知識、訊號與 raw 檔。只讀一次並以 project 層為準；
   * 需要全域層時請把 --global 指到另一個來源。
   */
  if (
    globalRoot !== undefined &&
    canonicalizePath(globalRoot) === canonicalizePath(projectRoot)
  ) {
    warnings.add(
      `GLOBAL_SOURCE_SAME_AS_PROJECT: ${globalRoot} 與專案來源相同，只讀一次並視為 project 層`,
    );
    globalRoot = undefined;
  }

  let plansRead: RegistryRead | undefined;
  try {
    plansRead = readRegistry(
      join(projectRoot, "plans.json"),
      "plans.json",
      "plans",
      "planId",
      PLANS_REGISTRY_FIELDS,
      warnings,
      false,
    );
  } catch (error) {
    if (error instanceof ExportV3Error) {
      warnings.add(`INVALID_PLANS_REGISTRY: ${error.message}`);
    } else {
      throw error;
    }
  }

  let tasksRead: RegistryRead | undefined;
  try {
    tasksRead = readRegistry(
      join(projectRoot, "tasks.json"),
      "tasks.json",
      "tasks",
      "taskId",
      TASKS_REGISTRY_FIELDS,
      warnings,
      true,
    );
  } catch (error) {
    if (
      error instanceof ExportV3Error &&
      error.code === "TASKS_REGISTRY_INVALID" &&
      plansRead !== undefined
    ) {
      warnings.add(`REGISTRY_PARSE_ERROR: ${error.message}`);
      const planProjectId = asNonEmptyString(plansRead.registry.projectId);
      tasksRead = {
        registry: {
          ...(planProjectId === undefined ? {} : { projectId: planProjectId }),
          tasks: {},
        },
        entries: [],
      };
    } else {
      throw error;
    }
  }
  if (tasksRead === undefined) {
    throw new ExportV3Error("TASKS_REGISTRY_MISSING", "缺少 tasks.json");
  }

  const projectId =
    asNonEmptyString(tasksRead.registry.projectId) ??
    asNonEmptyString(plansRead?.registry.projectId);
  if (projectId === undefined) {
    throw new ExportV3Error(
      "PROJECT_ID_MISSING",
      "tasks.json 與 plans.json 都沒有可用的 projectId",
    );
  }
  const tasksProjectId = asNonEmptyString(tasksRead.registry.projectId);
  const plansProjectId = asNonEmptyString(plansRead?.registry.projectId);
  if (tasksProjectId !== undefined && plansProjectId !== undefined && tasksProjectId !== plansProjectId) {
    warnings.add(`PROJECT_ID_MISMATCH: tasks.json=${tasksProjectId} plans.json=${plansProjectId}`);
  }

  const projectVersion = asNonEmptyString(tasksRead.registry.version) ??
    asNonEmptyString(plansRead?.registry.version);

  const rawFiles: RawFile[] = walkLayer(projectRoot, "project", warnings);
  if (globalRoot !== undefined) rawFiles.push(...walkLayer(globalRoot, "global", warnings));
  const safePaths = assignSafePaths(rawFiles);
  const files: SourceFileEntry[] = [];
  for (const file of rawFiles) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.absolutePath);
    } catch (error) {
      throw new ExportV3Error("SOURCE_UNREADABLE", `無法讀取 ${file.relativePath}`, [String(error)]);
    }
    files.push({
      layer: file.layer,
      relativePath: file.relativePath,
      safePath: safePaths.get(file) ?? sanitizeRelativePath(file.relativePath),
      absolutePath: file.absolutePath,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
    });
  }
  files.sort((left, right) => {
    const layerOrder = compareCodePoints(left.layer, right.layer);
    return layerOrder !== 0
      ? layerOrder
      : compareCodePoints(left.relativePath, right.relativePath);
  });
  classifyFiles(files, warnings);

  const fileByLayerPath = (layer: Layer, relativePath: string): SourceFileEntry | undefined =>
    files.find((file) => file.layer === layer && file.relativePath === relativePath);

  const audit = readJsonLines(fileByLayerPath("project", "audit.jsonl"), warnings);
  const memoryLogs: JsonLineEntry[] = [
    ...readJsonLines(fileByLayerPath("project", "memory/log.jsonl"), warnings),
    ...readJsonLines(fileByLayerPath("global", "memory/log.jsonl"), warnings),
  ];

  for (const entry of [...tasksRead.entries]) {
    for (const key of Object.keys(entry.record)) {
      if (!TASK_FIELDS.has(key)) {
        warnings.add(`UNMAPPED_TASK_FIELD: ${entry.key}.${key}`);
      }
    }
    for (const key of TASK_RAW_ONLY_FIELDS) {
      if (hasMeaningfulValue(entry.record[key])) {
        warnings.add(`RAW_ONLY_TASK_FIELD: ${entry.key}.${key}`);
      }
    }
  }
  for (const entry of plansRead?.entries ?? []) {
    for (const key of Object.keys(entry.record)) {
      if (!PLAN_FIELDS.has(key)) {
        warnings.add(`UNMAPPED_PLAN_FIELD: ${entry.key}.${key}`);
      }
    }
    for (const key of PLAN_RAW_ONLY_FIELDS) {
      if (hasMeaningfulValue(entry.record[key])) {
        warnings.add(`RAW_ONLY_PLAN_FIELD: ${entry.key}.${key}`);
      }
    }
  }

  return {
    projectRoot,
    ...(globalRoot === undefined ? {} : { globalRoot }),
    projectId,
    ...(projectVersion === undefined ? {} : { registryVersion: projectVersion }),
    tasksRegistry: tasksRead.registry,
    ...(plansRead === undefined ? {} : { plansRegistry: plansRead.registry }),
    tasks: tasksRead.entries,
    plans: plansRead?.entries ?? [],
    audit,
    memoryLogs,
    topics: readTopics(files, warnings),
    skills: readSkills(files, warnings),
    files,
    warnings,
  };
}
