import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { smileworkDatabasePath } from "../shared/paths.ts";
import { migrate as runMigrations } from "./migrate.ts";

export interface OpenDatabaseOptions {
  /** 直接指定資料庫檔路徑，優先於 home。 */
  path?: string;
  /** 指定 SMILEWORK_HOME 對應的目錄。 */
  home?: string;
  /** 是否自動套用 migration，預設 true。 */
  migrate?: boolean;
  /** 解析預設 home 時使用的環境變數。 */
  env?: NodeJS.ProcessEnv;
  /** migration 目錄，測試或打包時可覆寫。 */
  migrationsDir?: string;
}

/**
 * 開啟資料庫並設定多程序共用需要的 PRAGMA。
 * busy_timeout 必須在 journal_mode=WAL 之前設定，否則並行啟動會遇到 SQLITE_BUSY_RECOVERY。
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Database {
  const path = resolveDatabasePath(options);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });
  configureConnection(db);
  if (options.migrate !== false) {
    runMigrations(db, options.migrationsDir);
  }
  return db;
}

function resolveDatabasePath(options: OpenDatabaseOptions): string {
  if (options.path) return options.path === ":memory:" ? options.path : resolve(options.path);
  if (options.home) return join(resolve(options.home), "smilework.db");
  return smileworkDatabasePath(options.env ?? process.env);
}

export function configureConnection(db: Database): void {
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}
