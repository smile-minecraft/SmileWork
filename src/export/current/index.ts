import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { PRODUCER_VERSION } from "../../export/v3/index.ts";
import type { Manifest } from "../../import/types.ts";
import { WarningCollector } from "../../import/warnings.ts";
import { preferRegisteredAncestor } from "../../project/registry.ts";
import { resolveProject } from "../../project/resolve.ts";
import { expandHome, smileworkDatabasePath, smileworkHome } from "../../shared/paths.ts";
import { buildCurrentPackage } from "./build.ts";
import { ExportCurrentError } from "./errors.ts";
import { writeCurrentPackage } from "./write.ts";
import type { CurrentPackage } from "./types.ts";

export { ExportCurrentError } from "./errors.ts";
export type { CurrentPackage, RawOutput } from "./types.ts";

export interface ExportCurrentOptions {
  /** 輸出資料夾。 */
  outDir: string;
  /** 直接指定 `SMILEWORK_HOME`。 */
  home?: string;
  /** 直接指定資料庫檔。 */
  dbPath?: string;
  /** 解析預設 home 時使用的環境變數。 */
  env?: NodeJS.ProcessEnv;
  /** 專案 ID 或路徑；資料庫只有一個專案時可以省略。 */
  projectId?: string;
  /** 目標資料夾已有內容時是否取代。 */
  force?: boolean;
  /** 固定 manifest.createdAt；測試與重現用。 */
  createdAt?: string;
  /** 測試可以注入現在時間。 */
  now?: () => Date;
  /** 測試可以注入 OS 家目錄；CLI 不傳時使用 homedir()。 */
  osHome?: string;
}

export interface ExportCurrentResult {
  outDir: string;
  projectId: string;
  manifest: Manifest;
  warnings: string[];
}

function databasePath(options: ExportCurrentOptions, home: string): string {
  if (options.dbPath !== undefined) return resolve(options.dbPath);
  if (options.home !== undefined) return join(home, "smilework.db");
  return smileworkDatabasePath(options.env ?? process.env);
}

function canonicalPath(input: string): string {
  let current = resolve(input);
  const suffix: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return resolve(realpathSync(current), ...suffix);
      } catch {
        return resolve(input);
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(input);
    suffix.unshift(basename(current));
    current = parent;
  }
}

function isSameOrAncestor(candidate: string, target: string): boolean {
  const rel = relative(candidate, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertOutputAllowed(
  outDir: string,
  protectedAncestors: readonly string[],
  protectedTrees: readonly string[],
): void {
  const candidate = canonicalPath(outDir);
  for (const protectedPath of protectedAncestors) {
    const target = canonicalPath(protectedPath);
    if (isSameOrAncestor(candidate, target)) {
      throw new ExportCurrentError(
        "OUTPUT_PROTECTED",
        `輸出位置不能是家目錄、SMILEWORK_HOME、它們的上層或包含資料庫的目錄：${outDir}`,
        [target],
      );
    }
  }
  for (const protectedPath of protectedTrees) {
    const target = canonicalPath(protectedPath);
    if (isSameOrAncestor(candidate, target) || isSameOrAncestor(target, candidate)) {
      throw new ExportCurrentError(
        "OUTPUT_PROTECTED",
        `輸出位置不能覆蓋資料庫資料目錄：${outDir}`,
        [target],
      );
    }
  }
}

function normalizeCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new ExportCurrentError(
      "INVALID_ARGUMENT",
      `createdAt 必須是 UTC ISO 8601 時間，例如 2026-01-01T00:00:00.000Z：${value}`,
    );
  }
  return value;
}

function selectProject(db: Database, options: ExportCurrentOptions): string {
  const rows = db
    .query<{ project_id: string }, []>("SELECT project_id FROM projects ORDER BY project_id")
    .all();
  if (rows.length === 0) {
    throw new ExportCurrentError(
      "NO_PROJECT",
      "資料庫沒有專案可以匯出；先執行 smilework import 或建立專案。",
    );
  }
  const known = new Set(rows.map((row) => row.project_id));

  const requested = options.projectId?.trim();
  if (requested !== undefined && requested !== "") {
    if (known.has(requested)) return requested;
    try {
      const context = preferRegisteredAncestor(
        db,
        resolveProject({
          explicitPath: requested,
          env: options.env ?? process.env,
        }),
      );
      if (known.has(context.projectId)) return context.projectId;
    } catch {
      // 不是路徑時，下面的錯誤會說明找不到專案。
    }
    throw new ExportCurrentError(
      "PROJECT_NOT_FOUND",
      `資料庫沒有這個專案：${requested}`,
      [...known].sort(),
    );
  }

  try {
    const context = preferRegisteredAncestor(
      db,
      resolveProject({ env: options.env ?? process.env }),
    );
    if (known.has(context.projectId)) return context.projectId;
  } catch {
    // 目前目錄不是 git repo 時，只能靠單一專案或 --project。
  }

  if (rows.length === 1) return rows[0]!.project_id;
  throw new ExportCurrentError(
    "PROJECT_REQUIRED",
    "資料庫有多個專案；請用 --project 指定專案 ID 或路徑。",
    [...known].sort(),
  );
}

/** 從目前資料庫輸出 `smilework-export` v1。 */
export function exportCurrent(options: ExportCurrentOptions): ExportCurrentResult {
  const env = options.env ?? process.env;
  const osHome = resolve(options.osHome ?? homedir());
  const smileHome = resolve(options.home ?? smileworkHome(env));
  const home = resolve(
    options.home ??
      (options.dbPath !== undefined ? dirname(resolve(options.dbPath)) : smileworkHome(env)),
  );
  const path = databasePath(options, home);
  const outDir = expandHome(options.outDir, osHome);

  assertOutputAllowed(
    outDir,
    [osHome, smileHome, home, path, dirname(path)],
    [
      join(smileHome, "blobs"),
      join(smileHome, "knowledge-store"),
      join(smileHome, "transcripts.db"),
    ],
  );

  if (!existsSync(path)) {
    throw new ExportCurrentError("DATABASE_NOT_FOUND", `找不到資料庫：${path}`);
  }

  const createdAt =
    options.createdAt === undefined
      ? (options.now?.() ?? new Date()).toISOString()
      : normalizeCreatedAt(options.createdAt);

  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 15000");
    const projectId = selectProject(db, options);
    const warnings = new WarningCollector();
    const pkg: CurrentPackage = buildCurrentPackage(
      db,
      {
        home,
        projectId,
        createdAt,
        producerVersion: PRODUCER_VERSION,
      },
      warnings,
    );
    const written = writeCurrentPackage(outDir, pkg, {
      force: options.force ?? false,
    });
    return {
      outDir: written,
      projectId,
      manifest: pkg.manifest,
      warnings: pkg.manifest.warnings,
    };
  } finally {
    db.close();
  }
}
