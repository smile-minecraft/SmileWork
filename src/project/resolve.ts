import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ProjectContext } from "../domain/project.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { projectIdFromCommonDir, projectIdFromPath } from "../shared/hash.ts";
import { canonicalizePath } from "../shared/paths.ts";
import { gitLocationFor } from "./git.ts";
import { findLegacyProjectIdentity } from "./legacy.ts";

export interface ResolveProjectOptions {
  /** 工具參數提供的專案路徑或 repo 內路徑。 */
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface ProjectSource {
  kind: "argument" | "env" | "cwd";
  path: string;
}

function pickSource(options: ResolveProjectOptions, env: NodeJS.ProcessEnv): ProjectSource {
  const explicit = options.explicitPath?.trim();
  if (explicit) return { kind: "argument", path: explicit };

  const fromEnv = env.SMILEWORK_PROJECT?.trim();
  if (fromEnv) return { kind: "env", path: fromEnv };

  return { kind: "cwd", path: options.cwd ?? process.cwd() };
}

function sourceLabel(kind: ProjectSource["kind"]): string {
  if (kind === "argument") return "工具參數";
  if (kind === "env") return "SMILEWORK_PROJECT";
  return "程序 cwd";
}

function resolveSourcePath(source: ProjectSource, cwd: string): string {
  if (source.path === "~") return homedir();
  if (source.path.startsWith("~/")) return resolve(homedir(), source.path.slice(2));
  return isAbsolute(source.path) ? resolve(source.path) : resolve(cwd, source.path);
}

function ensureDirectory(path: string, source: ProjectSource): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new SmileworkError(
      ERROR_CODES.projectNotFound,
      `找不到專案目錄：${path}`,
      `確認 ${sourceLabel(source.kind)} 指向存在的資料夾，或改用 SMILEWORK_PROJECT 指定。`,
      { path, source: source.kind },
    );
  }
}

function isBroadRoot(path: string): boolean {
  return (
    path === "/" ||
    path === canonicalizePath("/tmp") ||
    path === canonicalizePath(tmpdir())
  );
}

/**
 * 專案解析順序：工具參數、SMILEWORK_PROJECT、程序 cwd。
 * 先找 git 根目錄；不是 git repo 時，依序改用：
 * 1. 上層 `.ultrawork/tasks.json` 記錄的舊 projectId，接回匯入的專案。
 * 2. 正規化絕對路徑雜湊出的專案身分。這一層只認目前路徑本身，不會往上找。
 *
 * 工具與 status 會在解析後再到資料庫找已登記的上層路徑專案
 * （`preferRegisteredAncestor`），所以先在 X 建工作、之後在 X/plugins 開啟時
 * 會接回 X。`resolveProject` 本身不碰資料庫，才能給唯讀與 CLI 解析共用。
 * 檔案系統根目錄與系統暫存根目錄不建立路徑專案，避免冒出無意義的專案。
 */
export function resolveProject(options: ResolveProjectOptions = {}): ProjectContext {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const source = pickSource(options, env);
  const path = resolveSourcePath(source, cwd);
  ensureDirectory(path, source);

  const location = gitLocationFor(path);
  if (location) {
    return {
      projectId: projectIdFromCommonDir(location.commonDir),
      worktreePath: location.rootPath,
      commonDir: location.commonDir,
      rootPath: location.mainWorktreePath,
    };
  }

  const canonical = canonicalizePath(path);
  if (isBroadRoot(canonical)) {
    throw new SmileworkError(
      ERROR_CODES.projectRequired,
      `這個位置太廣泛，不能當成專案根目錄：${canonical}`,
      "在實際的專案資料夾內執行，或用 SMILEWORK_PROJECT 指定專案路徑。",
      { path: canonical, source: source.kind },
    );
  }

  const legacy = findLegacyProjectIdentity(canonical, env);
  if (legacy) {
    return {
      projectId: legacy.projectId,
      worktreePath: canonical,
      commonDir: `import:${legacy.projectId}`,
      rootPath: legacy.rootPath,
    };
  }

  return {
    projectId: projectIdFromPath(canonical),
    worktreePath: canonical,
    commonDir: `path:${canonical}`,
    rootPath: canonical,
  };
}

/** 解析失敗時回 null，給唯讀工具決定是否降級。 */
export function tryResolveProject(options: ResolveProjectOptions = {}): ProjectContext | null {
  try {
    return resolveProject(options);
  } catch (error) {
    if (error instanceof SmileworkError) return null;
    throw error;
  }
}

/**
 * 寫入類工具使用這個入口：無法解析時直接丟出帶 nextAction 的錯誤，
 * 不讓呼叫端自行猜測是否要寫入。
 */
export function requireProject(options: ResolveProjectOptions = {}): ProjectContext {
  return resolveProject(options);
}
