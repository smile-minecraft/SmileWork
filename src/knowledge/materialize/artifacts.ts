import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import type { KnowledgeEntry, KnowledgeKind, KnowledgeLayer, KnowledgeType } from "../../domain/knowledge.ts";
import { atomicWriteFile } from "../../shared/atomic-write.ts";
import { assertPathAllowed, guardRoots } from "../../shared/path-guard.ts";
import { formatMemoryDocument } from "./document.ts";
import { invalidKnowledgeInput, KNOWLEDGE_TOOL_ERROR_CODES } from "./errors.ts";
import {
  archiveLayerSegment,
  archiveRoot,
  assertPathSegment,
  memoryFilesRoot,
  memoryRoot,
  memoryTopicPath,
  normalizeRelativeFilePath,
  skillArtifactPath,
} from "./paths.ts";
import { SmileworkError } from "../../shared/errors.ts";

export interface KnowledgeAuxFile {
  path: string;
  content: string;
}

export interface MemoryMetadata {
  title: string;
  description: string;
  type: KnowledgeType;
  pinned: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string;
}

export interface MaterializeKnowledgeInput {
  kind: KnowledgeKind;
  layer: KnowledgeLayer;
  projectId: string | null;
  knowledgeId: string;
  content: string;
  files: readonly KnowledgeAuxFile[];
  home: string;
  smileworkHome: string;
  projectPath: string | null;
  memory?: MemoryMetadata;
  mode: "create" | "update";
  /** 明確要求附件以這次 files 為完整集合時，才刪除未列出的舊附檔。 */
  pruneStaleFiles?: boolean;
}

export interface MaterializedFile {
  path: string;
  absolutePath: string;
  bytes: number;
}

export interface MaterializeResult {
  artifactPath: string;
  files: MaterializedFile[];
  createdPaths: string[];
  createdRoot: boolean;
}

export interface ArchivedArtifact {
  from: string;
  to: string;
}

export interface RetireArtifactInput {
  entry: Pick<KnowledgeEntry, "kind" | "layer" | "projectId" | "knowledgeId">;
  home: string;
  smileworkHome: string;
  projectPath: string | null;
}

export interface RetireArtifactResult {
  archived: ArchivedArtifact[];
  missing: string[];
}

interface WriteContext {
  roots: ReturnType<typeof guardRoots>;
  createdPaths: string[];
}

function ensureDirectory(path: string, context: WriteContext): void {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(path, { recursive: true });
  for (const directory of missing.reverse()) {
    if (!context.createdPaths.includes(directory)) context.createdPaths.push(directory);
  }
}

function writeTextFile(
  absolutePath: string,
  content: string,
  root: string,
  context: WriteContext,
): MaterializedFile {
  assertNoSymlinkComponents(root, absolutePath);
  assertPathAllowed(absolutePath, context.roots, { label: "知識檔案" });
  ensureDirectory(dirname(absolutePath), context);
  const existed = existsSync(absolutePath);
  atomicWriteFile(absolutePath, content);
  if (!existed && !context.createdPaths.includes(absolutePath)) {
    context.createdPaths.push(absolutePath);
  }
  return {
    path: relative(root, absolutePath).replaceAll("\\", "/"),
    absolutePath,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * 寫入路徑的既有元件不能是 symlink。路徑本身已限制在 root 內，
 * 這裡再擋掉用 symlink 把寫入導到其他位置的技巧。
 */
function assertNoSymlinkComponents(root: string, target: string): void {
  const rejectSymlink = (path: string): void => {
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isSymbolicLink()) return;
    throw invalidKnowledgeInput(
      `知識檔案路徑包含 symlink：${path}`,
      "移除技能資料夾內的 symlink，或改用實體目錄後再寫入。",
      { field: "files", path },
    );
  };

  rejectSymlink(root);
  const relativePath = relative(root, target);
  if (relativePath === "") return;
  if (relativePath.startsWith("..")) {
    throw invalidKnowledgeInput(
      `知識檔案路徑逃逸根目錄：${target}`,
      "改用根目錄以下的相對路徑。",
      { field: "files", path: target },
    );
  }
  const directory = dirname(relativePath);
  if (directory === ".") return;

  let current = root;
  for (const part of directory.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    rejectSymlink(current);
  }
}

function assertCreateTargetFree(path: string, label: string): void {
  if (!existsSync(path)) return;
  throw new SmileworkError(
    KNOWLEDGE_TOOL_ERROR_CODES.targetExists,
    `${label}已經存在：${path}`,
    "換一個名稱，或先確認既有檔案是不是同一個知識項目；更新時請帶 expectedVersion。",
    { path },
  );
}

function normalizeAuxFiles(files: readonly KnowledgeAuxFile[]): KnowledgeAuxFile[] {
  const seen = new Set<string>();
  return files.map((file, index) => {
    const field = `files[${index}].path`;
    const path = normalizeRelativeFilePath(file.path, field);
    if (seen.has(path)) {
      throw invalidKnowledgeInput(`附檔路徑重複：${path}`, "每個附檔只能出現一次。", {
        field,
        path,
      });
    }
    seen.add(path);
    return { path, content: file.content };
  });
}

interface SkillTree {
  files: string[];
  directories: string[];
}

/** 只列技能資料夾內的實體；不跟隨 symlink，symlink 本身當成檔案。 */
function listSkillTree(root: string): SkillTree {
  const files: string[] = [];
  const directories: string[] = [];

  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        directories.push(path);
        walk(absolute);
      } else {
        files.push(path);
      }
    }
  };

  walk(root);
  return { files, directories };
}

/** 更新技能時移除這次沒有列出的舊附檔；只動技能資料夾內的路徑。 */
function pruneSkillAttachments(
  root: string,
  desiredPaths: ReadonlySet<string>,
): void {
  const tree = listSkillTree(root);

  for (const file of tree.files) {
    if (desiredPaths.has(file)) continue;
    unlinkSync(join(root, file));
  }

  for (const directory of tree.directories.sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(join(root, directory));
    } catch {
      // 目錄還有其他檔案時保留。
    }
  }
}

function materializeSkill(input: MaterializeKnowledgeInput, context: WriteContext): MaterializeResult {
  const root = skillArtifactPath(
    input.home,
    input.projectPath,
    input.layer,
    input.knowledgeId,
  );
  assertPathAllowed(root, context.roots, { label: "技能資料夾" });
  if (input.mode === "create") assertCreateTargetFree(root, "技能資料夾");

  const createdRoot = !existsSync(root);
  const auxFiles = normalizeAuxFiles(input.files);
  if (auxFiles.some((file) => file.path.toLowerCase() === "skill.md")) {
    throw invalidKnowledgeInput("content 已經是 SKILL.md，files 不能再包含 SKILL.md。", "把主要內容放在 content。", {
      field: "files",
    });
  }

  const files: MaterializedFile[] = [];
  const targets = [
    { path: "SKILL.md", content: input.content },
    ...auxFiles,
  ];
  for (const target of targets) {
    const absolutePath = join(root, target.path);
    assertNoSymlinkComponents(root, absolutePath);
    assertPathAllowed(absolutePath, context.roots, { label: "技能附檔" });
  }

  for (const target of targets) {
    files.push(writeTextFile(join(root, target.path), target.content, root, context));
  }

  if (input.mode === "update" && input.pruneStaleFiles === true) {
    pruneSkillAttachments(
      root,
      new Set(["SKILL.md", ...auxFiles.map((file) => file.path)]),
    );
  }

  return { artifactPath: root, files, createdPaths: context.createdPaths, createdRoot };
}

function materializeMemory(input: MaterializeKnowledgeInput, context: WriteContext): MaterializeResult {
  if (!input.memory) {
    throw invalidKnowledgeInput("寫入記憶缺少 frontmatter 資料。", "回報這個問題；工具應該先組好記憶的 metadata。", {
      field: "kind",
    });
  }

  const root = memoryRoot(input.smileworkHome, input.layer, input.projectId);
  const topicPath = memoryTopicPath(
    input.smileworkHome,
    input.layer,
    input.projectId,
    input.knowledgeId,
  );
  assertPathAllowed(topicPath, context.roots, { label: "記憶檔案" });
  if (input.mode === "create") assertCreateTargetFree(topicPath, "記憶檔案");

  const auxFiles = normalizeAuxFiles(input.files);
  const filesRoot =
    auxFiles.length > 0
      ? memoryFilesRoot(
          input.smileworkHome,
          input.layer,
          input.projectId,
          input.knowledgeId,
        )
      : null;
  if (filesRoot !== null) {
    assertPathAllowed(filesRoot, context.roots, { label: "記憶附檔資料夾" });
    if (input.mode === "create") assertCreateTargetFree(filesRoot, "記憶附檔資料夾");
    for (const file of auxFiles) {
      const target = join(filesRoot, file.path);
      assertNoSymlinkComponents(root, target);
      assertPathAllowed(target, context.roots, { label: "記憶附檔" });
    }
  }

  const document = formatMemoryDocument({ ...input.memory, content: input.content });
  assertNoSymlinkComponents(root, topicPath);
  const files: MaterializedFile[] = [
    writeTextFile(topicPath, document, dirname(topicPath), context),
  ];

  if (filesRoot !== null) {
    for (const file of auxFiles) {
      files.push(writeTextFile(join(filesRoot, file.path), file.content, filesRoot, context));
    }
  }

  return {
    artifactPath: topicPath,
    files,
    createdPaths: context.createdPaths,
    createdRoot: false,
  };
}

/** 把知識內容落地成宿主載入的實體檔案。 */
export function materializeKnowledge(
  input: MaterializeKnowledgeInput,
): MaterializeResult {
  assertPathSegment(input.knowledgeId, "knowledgeId");
  const context: WriteContext = {
    roots: guardRoots({
      home: input.home,
      smileworkHome: input.smileworkHome,
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    }),
    createdPaths: [],
  };
  try {
    return input.kind === "skill"
      ? materializeSkill(input, context)
      : materializeMemory(input, context);
  } catch (error) {
    discardCreatedPaths(context.createdPaths);
    throw error;
  }
}

/** 建立失敗時清掉這次新建的檔案；既有檔案不會被刪除。 */
export function discardMaterialized(result: MaterializeResult): void {
  if (result.createdRoot) {
    rmSync(result.artifactPath, { recursive: true, force: true });
    return;
  }
  discardCreatedPaths(result.createdPaths);
}

function discardCreatedPaths(paths: readonly string[]): void {
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: false, force: true });
    } catch {
      // 目錄還有其他檔案時保留，交給下一次操作處理。
    }
  }
}

function suffixPath(target: string, suffix: string): string {
  const extension = extname(target);
  return extension.length > 0
    ? `${target.slice(0, -extension.length)}${suffix}${extension}`
    : `${target}${suffix}`;
}

function uniqueArchiveTarget(target: string): string {
  if (!existsSync(target)) return target;
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  let candidate = suffixPath(target, `.retired-${stamp}`);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = suffixPath(target, `.retired-${stamp}-${counter}`);
    counter += 1;
  }
  return candidate;
}

function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

/** 退役時把實體檔案移到封存區，回傳實際搬移與找不到的來源。 */
export function retireKnowledgeArtifact(input: RetireArtifactInput): RetireArtifactResult {
  const roots = guardRoots({
    home: input.home,
    smileworkHome: input.smileworkHome,
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  });
  const layerSegments = archiveLayerSegment(input.entry.layer, input.entry.projectId);
  const moves: Array<{ from: string; to: string }> = [];

  if (input.entry.kind === "skill") {
    const from = skillArtifactPath(
      input.home,
      input.projectPath,
      input.entry.layer,
      input.entry.knowledgeId,
    );
    const to = join(
      archiveRoot(input.smileworkHome),
      "skills",
      ...layerSegments,
      input.entry.knowledgeId,
    );
    moves.push({ from, to });
  } else {
    const from = memoryTopicPath(
      input.smileworkHome,
      input.entry.layer,
      input.entry.projectId,
      input.entry.knowledgeId,
    );
    const to = join(
      archiveRoot(input.smileworkHome),
      "memory",
      ...layerSegments,
      "topics",
      `${input.entry.knowledgeId}.md`,
    );
    moves.push({ from, to });

    const filesFrom = memoryFilesRoot(
      input.smileworkHome,
      input.entry.layer,
      input.entry.projectId,
      input.entry.knowledgeId,
    );
    const filesTo = join(
      archiveRoot(input.smileworkHome),
      "memory",
      ...layerSegments,
      "files",
      input.entry.knowledgeId,
    );
    moves.push({ from: filesFrom, to: filesTo });
  }

  const archived: ArchivedArtifact[] = [];
  const missing: string[] = [];
  for (const move of moves) {
    if (!existsSync(move.from)) {
      missing.push(move.from);
      continue;
    }
    assertPathAllowed(move.from, roots, { label: "退役來源" });
    const target = uniqueArchiveTarget(move.to);
    assertPathAllowed(target, roots, { label: "封存位置" });
    try {
      movePath(move.from, target);
    } catch (error) {
      throw new SmileworkError(
        KNOWLEDGE_TOOL_ERROR_CODES.archiveFailed,
        `無法把 ${move.from} 移到封存區：${error instanceof Error ? error.message : String(error)}`,
        "確認檔案權限與磁碟空間後重試；資料庫狀態已保留，重試不會重複建立版本。",
        { from: move.from, to: target },
      );
    }
    archived.push({ from: move.from, to: target });
  }

  return { archived, missing };
}
