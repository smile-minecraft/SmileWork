import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ProjectContext } from "../domain/project.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { projectIdFromCommonDir } from "../shared/hash.ts";
import { gitLocationFor } from "./git.ts";

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
      `確認 ${sourceLabel(source.kind)} 指向存在的 git repo，或改用 SMILEWORK_PROJECT 指定。`,
      { path, source: source.kind },
    );
  }
}

/**
 * 專案解析順序：工具參數、SMILEWORK_PROJECT、程序 cwd。
 * 解析成功後一律回傳 git common dir 正規化後的 projectId；
 * 同一個 repo 的不同 worktree 會得到相同 projectId。
 */
export function resolveProject(options: ResolveProjectOptions = {}): ProjectContext {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const source = pickSource(options, env);
  const path = resolveSourcePath(source, cwd);
  ensureDirectory(path, source);

  const location = gitLocationFor(path);
  if (!location) {
    if (source.kind === "cwd") {
      throw new SmileworkError(
        ERROR_CODES.projectRequired,
        `目前目錄不是 git repo，無法判斷專案：${path}`,
        "設定 SMILEWORK_PROJECT 指向 repo，或在工具參數提供專案路徑。",
        { path, source: source.kind },
      );
    }
    throw new SmileworkError(
      ERROR_CODES.notGitRepository,
      `專案不是 git repo：${path}`,
      "在 git repo 內執行，或把 SMILEWORK_PROJECT 指向 repo 或 worktree。",
      { path, source: source.kind },
    );
  }

  return {
    projectId: projectIdFromCommonDir(location.commonDir),
    worktreePath: location.rootPath,
    commonDir: location.commonDir,
    rootPath: location.mainWorktreePath,
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
