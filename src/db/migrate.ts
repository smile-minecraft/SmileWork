import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { nowIso } from "../shared/time.ts";
import { withImmediateTransaction } from "./transaction.ts";

/**
 * src/db、dist（打包後）與套件根目錄的相對位置不同，依序找第一個存在的
 * migrations 目錄；都沒有時回傳原始碼佈局的位置，讓錯誤訊息指出預期路徑。
 */
function defaultMigrationsDirectory(): string {
  const candidates = [
    resolve(import.meta.dir, "..", "..", "migrations"),
    resolve(import.meta.dir, "..", "migrations"),
    resolve(process.cwd(), "migrations"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

const DEFAULT_MIGRATIONS_DIR = defaultMigrationsDirectory();

export function migrationsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SMILEWORK_MIGRATIONS_DIR?.trim();
  return configured ? resolve(configured) : DEFAULT_MIGRATIONS_DIR;
}

interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

function listMigrations(directory: string): MigrationFile[] {
  const entries = readdirSync(directory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .map((name) => {
      const version = Number(name.match(/^(\d+)/)?.[1]);
      if (!Number.isInteger(version) || version < 1) {
        throw new Error(`migration 檔名沒有有效版本：${name}`);
      }
      return { version, name, path: join(directory, name) };
    })
    .sort((left, right) => left.version - right.version);

  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.version)) {
      throw new Error(`migration 版本重複：${entry.version}`);
    }
    seen.add(entry.version);
  }
  return entries;
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
}

/** 依版本順序套用尚未執行的 migration；每個檔案各自是一個 IMMEDIATE 交易。 */
export function migrate(db: Database, directory: string = migrationsDirectory()): number {
  ensureMigrationTable(db);
  const files = listMigrations(directory);
  let appliedCount = 0;

  for (const file of files) {
    const alreadyApplied = db
      .query<{ present: number }, [number]>(
        "SELECT 1 AS present FROM schema_migrations WHERE version = ?",
      )
      .get(file.version);
    if (alreadyApplied) continue;

    const sql = readFileSync(file.path, "utf8");
    withImmediateTransaction(db, () => {
      const raced = db
        .query<{ present: number }, [number]>(
          "SELECT 1 AS present FROM schema_migrations WHERE version = ?",
        )
        .get(file.version);
      if (raced) return;
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        file.version,
        file.name,
        nowIso(),
      );
      appliedCount += 1;
    });
  }

  return appliedCount;
}

export function schemaVersion(db: Database): number {
  ensureMigrationTable(db);
  const row = db
    .query<{ version: number | null }, []>("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  return row?.version ?? 0;
}
