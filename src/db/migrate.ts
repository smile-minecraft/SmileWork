import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { SmileworkError } from "../shared/errors.ts";
import { sha256Hex } from "../shared/hash.ts";
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

interface AppliedMigration {
  version: number;
  name: string;
  sha256: string | null;
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

/**
 * `schema_migrations` 由程式建立，不屬於任何 migration 檔。
 * 舊版資料庫沒有 sha256 欄位，這裡只補欄位，不重寫既有資料。
 */
function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      sha256 TEXT
    ) STRICT
  `);

  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(schema_migrations)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("sha256")) {
    db.exec("ALTER TABLE schema_migrations ADD COLUMN sha256 TEXT");
  }
}

function migrationHash(path: string): string {
  return sha256Hex(readFileSync(path, "utf8"));
}

function readAppliedMigrations(db: Database): AppliedMigration[] {
  return db
    .query<AppliedMigration, []>(
      "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
    )
    .all();
}

/**
 * 已套用的 migration 必須和檔案一致。舊資料列的 sha256 是 null，
 * 代表它是在開始記錄雜湊之前套用的；第一次啟動時補記目前檔案的雜湊，
 * 之後就能偵測到任何修改。
 */
function verifyAppliedMigrations(
  db: Database,
  files: readonly MigrationFile[],
): Map<number, string> {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const applied = readAppliedMigrations(db);
  const pendingBackfill = new Map<number, string>();

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new SmileworkError(
        "MIGRATION_FILE_MISSING",
        `資料庫記錄的 migration ${row.version}（${row.name}）找不到對應檔案。`,
        "把檔案放回 migrations 目錄，或從備份還原資料庫；不要直接刪掉資料庫的紀錄。",
        { version: row.version, name: row.name },
      );
    }

    if (row.name !== file.name) {
      throw new SmileworkError(
        "MIGRATION_RENAMED",
        `資料庫記錄的 migration ${row.version} 檔名是 ${row.name}，目前是 ${file.name}。`,
        "把檔名改回去，或新增一個新的 migration；不要重新命名已套用的檔案。",
        { version: row.version, recorded: row.name, actual: file.name },
      );
    }

    const actual = migrationHash(file.path);
    if (row.sha256 === null) {
      pendingBackfill.set(row.version, actual);
      continue;
    }
    if (row.sha256 !== actual) {
      throw new SmileworkError(
        "MIGRATION_HASH_MISMATCH",
        `migration ${row.version}（${file.name}）的內容在套用後被修改：資料庫記錄 ${row.sha256}，目前檔案 ${actual}。`,
        "還原這個 migration 檔，或新增一個新的 migration 來修正 schema；不要直接修改已套用的檔案。",
        { version: row.version, name: file.name, recorded: row.sha256, actual },
      );
    }
  }

  if (pendingBackfill.size > 0) {
    withImmediateTransaction(db, () => {
      for (const [version, hash] of pendingBackfill) {
        db.query(
          "UPDATE schema_migrations SET sha256 = ? WHERE version = ? AND sha256 IS NULL",
        ).run(hash, version);
      }
    });
  }

  return new Map(files.map((file) => [file.version, migrationHash(file.path)]));
}

/** 依版本順序套用尚未執行的 migration；每個檔案各自是一個 IMMEDIATE 交易。 */
export function migrate(db: Database, directory: string = migrationsDirectory()): number {
  ensureMigrationTable(db);
  const files = listMigrations(directory);
  const hashes = verifyAppliedMigrations(db, files);
  let appliedCount = 0;

  for (const file of files) {
    const alreadyApplied = db
      .query<{ present: number }, [number]>(
        "SELECT 1 AS present FROM schema_migrations WHERE version = ?",
      )
      .get(file.version);
    if (alreadyApplied) continue;

    const hash = hashes.get(file.version) ?? migrationHash(file.path);
    withImmediateTransaction(db, () => {
      const raced = db
        .query<{ present: number }, [number]>(
          "SELECT 1 AS present FROM schema_migrations WHERE version = ?",
        )
        .get(file.version);
      if (raced) return;
      db.exec(readFileSync(file.path, "utf8"));
      db.query(
        "INSERT INTO schema_migrations (version, name, applied_at, sha256) VALUES (?, ?, ?, ?)",
      ).run(file.version, file.name, nowIso(), hash);
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
