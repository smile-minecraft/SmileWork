import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Actor } from "../domain/actor.ts";
import { loadSmileworkConfig, type SmileworkConfig } from "../mcp/profiles.ts";
import { actorHint, resolveActor } from "../project/actor.ts";
import { resolveProject } from "../project/resolve.ts";
import { SmileworkError } from "../shared/errors.ts";
import {
  claudeSkillsDir,
  globalSkillsDir,
  smileworkDatabasePath,
  smileworkTranscriptsPath,
} from "../shared/paths.ts";
import { SERVER_NAME, SERVER_VERSION } from "../shared/version.ts";

export type DatabaseHealthStatus = "ok" | "missing" | "uninitialized" | "unavailable";

export type ProjectHealthStatus = "resolved" | "unresolved";

export type SkillHealthStatus =
  | "linked"
  | "partial"
  | "not_linked"
  | "broken"
  | "not_configured"
  | "unavailable";

export type TranscriptHealthStatus = "ready" | "not_indexed" | "unavailable";

export interface DatabaseHealth {
  path: string;
  exists: boolean;
  status: DatabaseHealthStatus;
  schemaVersion: number | null;
  sizeBytes: number | null;
  error: string | null;
}

export interface ProjectHealth {
  status: ProjectHealthStatus;
  projectId: string | null;
  rootPath: string | null;
  worktreePath: string | null;
  commonDir: string | null;
  code: string | null;
  reason: string | null;
  nextAction: string | null;
}

export interface ActorStatus extends Actor {
  hint: string | null;
}

export interface ProfileStatus {
  name: string;
  configured: boolean;
}

export interface SkillSourceHealth {
  path: string;
  exists: boolean;
  skills: string[];
}

export interface SkillLinkHealth {
  path: string;
  exists: boolean;
  symlinks: string[];
  broken: string[];
  missing: string[];
  conflicts: string[];
}

export interface SkillHealth {
  status: SkillHealthStatus;
  source: SkillSourceHealth;
  links: SkillLinkHealth;
  error: string | null;
}

export interface TranscriptHealth {
  path: string;
  exists: boolean;
  status: TranscriptHealthStatus;
  sizeBytes: number | null;
  updatedAt: string | null;
  error: string | null;
}

export interface StatusReport {
  version: { name: string; version: string };
  database: DatabaseHealth;
  project: ProjectHealth;
  actor: ActorStatus;
  profile: ProfileStatus;
  skills: SkillHealth;
  transcripts: TranscriptHealth;
  warnings: string[];
}

export interface InspectStatusOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  actor?: Actor;
  actorHint?: string | null;
  /** 已解析的設定；省略時依 env 與 cwd 解析，呼叫端可與其他檢查共用同一份結果。 */
  config?: SmileworkConfig;
}

/** 收集唯讀健康狀態；任何子系統失敗都只記 warning，不讓整份狀態失敗。 */
export function inspectStatus(options: InspectStatusOptions = {}): StatusReport {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  const actor = options.actor ?? resolveActor(env);
  const hint = options.actorHint === undefined ? actorHint(actor) : options.actorHint;
  if (hint) warnings.push(hint);

  const pathsEnv = envWithSmileworkHome(env);
  const config = options.config ?? loadSmileworkConfig({ env: pathsEnv, cwd });
  warnings.push(...config.warnings);

  return {
    version: { name: SERVER_NAME, version: SERVER_VERSION },
    database: inspectDatabase(pathsEnv, warnings),
    project: inspectProject(env, cwd, warnings),
    actor: { ...actor, hint },
    profile: {
      name: config.profile,
      configured: config.profileSource !== "default",
    },
    skills: inspectSkills(env, warnings),
    transcripts: inspectTranscripts(pathsEnv, warnings),
    warnings,
  };
}

/**
 * 呼叫端只給 HOME 時，資料庫、索引與全域設定仍要落在那個 home 之下。
 * 共用的路徑工具只認 SMILEWORK_HOME，這裡補上明確值，避免讀到真實家目錄。
 */
function envWithSmileworkHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.SMILEWORK_HOME?.trim()) return env;
  return { ...env, SMILEWORK_HOME: join(userHome(env), ".smilework") };
}

function inspectDatabase(env: NodeJS.ProcessEnv, warnings: string[]): DatabaseHealth {
  const path = smileworkDatabasePath(env);

  let fileSize: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      const message = `資料庫路徑不是檔案：${path}`;
      warnings.push(message);
      return unavailableDatabase(path, true, null, message);
    }
    fileSize = stat.size;
  } catch (error) {
    if (isMissingPathError(error)) {
      warnings.push(`資料庫尚未建立：${path}。第一次寫入時會自動建立。`);
      return {
        path,
        exists: false,
        status: "missing",
        schemaVersion: null,
        sizeBytes: null,
        error: null,
      };
    }
    const message = messageOf(error);
    warnings.push(`資料庫無法讀取：${message}（${path}）`);
    return unavailableDatabase(path, false, null, message);
  }

  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 1000");

    const integrity = readIntegrity(db);
    if (integrity !== "ok") {
      const message = `資料庫完整性檢查失敗：${integrity}`;
      warnings.push(`資料庫無法讀取：${message}（${path}）`);
      return unavailableDatabase(path, true, fileSize, message);
    }

    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion < 1) {
      warnings.push(`資料庫尚未初始化：${path}。第一次寫入時會自動套用 migration。`);
      return {
        path,
        exists: true,
        status: "uninitialized",
        schemaVersion,
        sizeBytes: fileSize,
        error: null,
      };
    }

    return {
      path,
      exists: true,
      status: "ok",
      schemaVersion,
      sizeBytes: fileSize,
      error: null,
    };
  } catch (error) {
    const message = messageOf(error);
    warnings.push(`資料庫無法讀取：${message}（${path}）`);
    return unavailableDatabase(path, true, fileSize, message);
  } finally {
    db?.close();
  }
}

function unavailableDatabase(
  path: string,
  exists: boolean,
  sizeBytes: number | null,
  error: string,
): DatabaseHealth {
  return {
    path,
    exists,
    status: "unavailable",
    schemaVersion: null,
    sizeBytes,
    error,
  };
}

function readIntegrity(db: Database): string {
  const row = db
    .query<{ quick_check: string }, []>("PRAGMA quick_check")
    .get();
  return row?.quick_check ?? "unknown";
}

function readSchemaVersion(db: Database): number {
  try {
    const row = db
      .query<{ version: number | null }, []>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      )
      .get();
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

function inspectProject(
  env: NodeJS.ProcessEnv,
  cwd: string,
  warnings: string[],
): ProjectHealth {
  try {
    const project = resolveProject({ env, cwd });
    return {
      status: "resolved",
      projectId: project.projectId,
      rootPath: project.rootPath,
      worktreePath: project.worktreePath,
      commonDir: project.commonDir,
      code: null,
      reason: null,
      nextAction: null,
    };
  } catch (error) {
    const reason = messageOf(error);
    const code = error instanceof SmileworkError ? error.code : null;
    const nextAction = error instanceof SmileworkError ? error.nextAction : null;
    warnings.push(`專案無法解析：${reason}`);
    return {
      status: "unresolved",
      projectId: null,
      rootPath: null,
      worktreePath: null,
      commonDir: null,
      code,
      reason,
      nextAction,
    };
  }
}

function inspectSkills(env: NodeJS.ProcessEnv, warnings: string[]): SkillHealth {
  const home = userHome(env);
  const sourcePath = globalSkillsDir(home);
  const linkPath = claudeSkillsDir(home);

  try {
    const source = readSkillSource(sourcePath);
    const links = readSkillLinks(linkPath, source.skills);
    const status = decideSkillStatus(source, links);
    pushSkillWarnings(status, source, links, warnings);
    return { status, source, links, error: null };
  } catch (error) {
    const message = messageOf(error);
    warnings.push(`技能狀態無法檢查：${message}（${sourcePath}、${linkPath}）`);
    return {
      status: "unavailable",
      source: { path: sourcePath, exists: false, skills: [] },
      links: {
        path: linkPath,
        exists: false,
        symlinks: [],
        broken: [],
        missing: [],
        conflicts: [],
      },
      error: message,
    };
  }
}

function readSkillSource(path: string): SkillSourceHealth {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return { path, exists: false, skills: [] };
    throw error;
  }

  const skills = entries
    .filter((name) => isDirectory(join(path, name)))
    .sort();
  return { path, exists: true, skills };
}

function readSkillLinks(path: string, sourceSkills: readonly string[]): SkillLinkHealth {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        path,
        exists: false,
        symlinks: [],
        broken: [],
        missing: [...sourceSkills],
        conflicts: [],
      };
    }
    throw error;
  }

  const symlinks: string[] = [];
  const broken: string[] = [];
  const conflicts: string[] = [];

  for (const name of entries.sort()) {
    const entryPath = join(path, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(entryPath);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      if (existsSync(entryPath)) symlinks.push(name);
      else broken.push(name);
    } else if (sourceSkills.includes(name)) {
      conflicts.push(name);
    }
  }

  const present = new Set(entries);
  return {
    path,
    exists: true,
    symlinks,
    broken,
    missing: sourceSkills.filter((name) => !present.has(name)),
    conflicts,
  };
}

function decideSkillStatus(
  source: SkillSourceHealth,
  links: SkillLinkHealth,
): SkillHealthStatus {
  if (!source.exists || source.skills.length === 0) return "not_configured";
  if (!links.exists) return "not_linked";
  if (links.broken.length > 0) return "broken";
  if (links.symlinks.length === 0) return "not_linked";
  if (links.missing.length > 0 || links.conflicts.length > 0) return "partial";
  return "linked";
}

function pushSkillWarnings(
  status: SkillHealthStatus,
  source: SkillSourceHealth,
  links: SkillLinkHealth,
  warnings: string[],
): void {
  if (status === "not_linked") {
    if (!links.exists) {
      warnings.push(`技能尚未連結：找不到連結目錄 ${links.path}。執行 smilework link 建立連結。`);
      return;
    }
    if (links.conflicts.length > 0) {
      warnings.push(
        `技能連結位置已有同名實體資料夾：${links.conflicts.join("、")}，未覆蓋。`,
      );
    }
    warnings.push(
      `技能尚未連結：${source.skills.join("、")}。執行 smilework link 建立連結到 ${links.path}。`,
    );
    return;
  }

  if (status === "broken") {
    warnings.push(`技能連結斷鏈：${links.broken.join("、")}。重新執行 smilework link 修復。`);
    return;
  }

  if (status === "partial") {
    if (links.conflicts.length > 0) {
      warnings.push(
        `技能連結位置已有同名實體資料夾：${links.conflicts.join("、")}，未覆蓋。`,
      );
    }
    if (links.missing.length > 0) {
      warnings.push(
        `有 ${links.missing.length} 個技能尚未連結到 ${links.path}：${links.missing.join("、")}。執行 smilework link 建立連結。`,
      );
    }
  }
}

function inspectTranscripts(env: NodeJS.ProcessEnv, warnings: string[]): TranscriptHealth {
  const path = smileworkTranscriptsPath(env);

  try {
    const stat = statSync(path);
    const updatedAt = stat.mtime.toISOString();
    if (!stat.isFile()) {
      const message = `對話索引路徑不是檔案：${path}`;
      warnings.push(message);
      return {
        path,
        exists: true,
        status: "unavailable",
        sizeBytes: null,
        updatedAt,
        error: message,
      };
    }

    if (stat.size === 0) {
      return {
        path,
        exists: true,
        status: "not_indexed",
        sizeBytes: 0,
        updatedAt,
        error: null,
      };
    }

    return {
      path,
      exists: true,
      status: "ready",
      sizeBytes: stat.size,
      updatedAt,
      error: null,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        path,
        exists: false,
        status: "not_indexed",
        sizeBytes: null,
        updatedAt: null,
        error: null,
      };
    }
    const message = messageOf(error);
    warnings.push(`對話索引無法讀取：${message}（${path}）`);
    return {
      path,
      exists: false,
      status: "unavailable",
      sizeBytes: null,
      updatedAt: null,
      error: message,
    };
  }
}

function userHome(env: NodeJS.ProcessEnv): string {
  const configured = env.HOME?.trim();
  if (configured) return configured;
  try {
    return homedir();
  } catch {
    return "";
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
