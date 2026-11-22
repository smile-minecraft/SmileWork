import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/index.ts";
import type { ProjectContext } from "../domain/project.ts";
import { resolveActor, actorHint } from "../project/actor.ts";
import { preferRegisteredAncestor, registerProject } from "../project/registry.ts";
import { resolveProject } from "../project/resolve.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import type { ToolContext } from "./types.ts";

export interface CreateToolContextOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 測試注入既有連線；注入的連線不會被 context 關閉。 */
  db?: Database;
  /** MCP 伺服器持有的共用連線；context 不會關閉它。 */
  sharedDb?: SharedDatabase;
  /** 測試可關閉自動登記專案。 */
  registerProject?: boolean;
}

/** 單一 MCP 伺服器 process 內共用的資料庫連線。 */
export interface SharedDatabase {
  get(): Database;
  close(): void;
}

/** 第一次用到才開啟資料庫，由呼叫端決定何時釋放。 */
export function createSharedDatabase(options: { env?: NodeJS.ProcessEnv } = {}): SharedDatabase {
  let database: Database | null = null;
  return {
    get(): Database {
      database ??= openDatabase({ env: options.env });
      return database;
    },
    close(): void {
      if (!database) return;
      database.close();
      database = null;
    },
  };
}

export function createToolContext(options: CreateToolContextOptions = {}): ToolContext {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const shouldRegister = options.registerProject !== false;

  let database: Database | null = options.db ?? null;
  const ownsDatabase = options.db === undefined && options.sharedDb === undefined;

  const db = (): Database => {
    if (!database) {
      database = options.sharedDb?.get() ?? openDatabase({ env });
    }
    return database;
  };

  const register = (project: ProjectContext): ProjectContext => {
    if (shouldRegister) registerProject(db(), project);
    return project;
  };

  const resolve = (explicitPath?: string): ProjectContext => {
    const base = resolveProject({ explicitPath, env, cwd });
    const preferred = base.commonDir.startsWith("path:")
      ? preferRegisteredAncestor(db(), base)
      : base;
    return register(preferred);
  };

  const actor = resolveActor(env);
  return {
    actor,
    actorHint: actorHint(actor),
    db,
    resolveProject(explicitPath?: string): ProjectContext {
      return resolve(explicitPath);
    },
    tryResolveProject(explicitPath?: string): ProjectContext | null {
      try {
        return resolve(explicitPath);
      } catch (error) {
        if (isProjectResolutionError(error)) return null;
        throw error;
      }
    },
    close(): void {
      if (!ownsDatabase || !database) return;
      database.close();
      database = null;
    },
  };
}

/** 確認錯誤碼是專案解析失敗，讓呼叫端可選擇降級或拒絕。 */
export function isProjectResolutionError(error: unknown): boolean {
  return (
    error instanceof SmileworkError &&
    (error.code === ERROR_CODES.projectRequired ||
      error.code === ERROR_CODES.projectNotFound ||
      error.code === ERROR_CODES.notGitRepository)
  );
}
