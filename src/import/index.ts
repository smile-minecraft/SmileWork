import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { openDatabase } from "../db/index.ts";
import { globalSkillsDir as defaultGlobalSkillsDir, smileworkDatabasePath, smileworkHome } from "../shared/paths.ts";
import { applyPackage, knowledgeKind } from "./apply.ts";
import { readPackage } from "./read.ts";
import type { ImportCounts, ImportResult, PackageContents } from "./types.ts";
import { WarningCollector } from "./warnings.ts";

export { ImportError } from "./errors.ts";
export type * from "./types.ts";

export interface ImportOptions {
  /** `smilework-export` v1 套件資料夾。 */
  packageDir: string;
  /** 直接指定 `SMILEWORK_HOME`。 */
  home?: string;
  /** 直接指定資料庫檔；優先於 home。 */
  dbPath?: string;
  /** 解析預設 home 時使用的環境變數。 */
  env?: NodeJS.ProcessEnv;
  /** 只列計數與警告，不開啟資料庫，也不建立任何目錄。 */
  dryRun?: boolean;
  /** 既有全域技能資料夾；測試可以指定暫存位置。 */
  globalSkillsDir?: string;
  /** 測試可以注入現在時間。 */
  now?: () => Date;
}

const ZERO_COUNTS: ImportCounts = {
  work: 0,
  events: 0,
  evidence: 0,
  signals: 0,
  knowledge: 0,
  knowledgeVersions: 0,
  mapping: 0,
  raw: 0,
};

function resolveDatabasePath(options: ImportOptions, home: string): string {
  if (options.dbPath !== undefined) return resolve(options.dbPath);
  if (options.home !== undefined) return join(home, "smilework.db");
  return smileworkDatabasePath(options.env ?? process.env);
}

function warnExistingSkills(
  contents: PackageContents,
  skillsDir: string,
  warnings: WarningCollector,
): void {
  const reported = new Set<string>();
  for (const entry of contents.knowledge) {
    if (knowledgeKind(entry.record) !== "skill") continue;
    for (const name of new Set([entry.record.title, entry.record.knowledgeId])) {
      if (name === "" || reported.has(name)) continue;
      const directory = join(skillsDir, name);
      if (!existsSync(directory)) continue;
      let isDirectory = false;
      try {
        isDirectory = statSync(directory).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      reported.add(name);
      warnings.add(`EXISTING_SKILL_REGISTERED ${name}：實體技能資料夾保持原樣`);
    }
  }
}

/** 把 `smilework-export` v1 套件寫進本機資料庫。 */
export function importPackage(options: ImportOptions): ImportResult {
  const env = options.env ?? process.env;
  const home = resolve(
    options.home ??
      (options.dbPath !== undefined ? dirname(resolve(options.dbPath)) : smileworkHome(env)),
  );
  const warnings = new WarningCollector();
  const { contents, counts } = readPackage(options.packageDir, warnings);

  const skillsDir = options.globalSkillsDir ?? defaultGlobalSkillsDir();
  warnExistingSkills(contents, skillsDir, warnings);

  if (options.dryRun === true) {
    return {
      packageDir: contents.root,
      projectId: contents.manifest.source.projectId,
      dryRun: true,
      counts,
      inserted: { ...ZERO_COUNTS },
      skipped: { ...ZERO_COUNTS },
      warnings: warnings.all(),
    };
  }

  const dbPath = resolveDatabasePath(options, home);
  const db = openDatabase({ path: dbPath });
  try {
    const applied = applyPackage(contents, db, {
      projectId: contents.manifest.source.projectId,
      home,
      now: options.now ?? (() => new Date()),
      warnings,
    });
    return {
      packageDir: contents.root,
      projectId: contents.manifest.source.projectId,
      dryRun: false,
      counts,
      inserted: applied.inserted,
      skipped: applied.skipped,
      warnings: warnings.all(),
      dbPath,
    };
  } finally {
    db.close();
  }
}
