import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, migrationsDirectory, openDatabase } from "../../src/db/index.ts";
import { withTempDir, withTempHome } from "../helpers/temp.ts";

const REQUIRED_TABLES = [
  "events",
  "evidence",
  "id_mappings",
  "idempotency_keys",
  "knowledge_entries",
  "knowledge_versions",
  "metadata",
  "project_worktrees",
  "projects",
  "schema_migrations",
  "signals",
  "usage_events",
  "work_dependencies",
  "work_items",
] as const;

const REQUIRED_INDEXES = [
  "idx_events_work",
  "idx_evidence_work",
  "idx_id_mappings_target",
  "idx_knowledge_entries_scope",
  "idx_knowledge_entries_status",
  "idx_knowledge_versions_sha",
  "idx_project_worktrees_path",
  "idx_projects_common_dir",
  "idx_signals_code",
  "idx_signals_kind",
  "idx_signals_status",
  "idx_usage_events_knowledge",
  "idx_work_dependencies_dep",
  "idx_work_items_plan",
  "idx_work_items_project_status",
] as const;

describe("資料庫與 migration", () => {
  test("migration 目錄可由原始碼佈局找到", () => {
    expect(existsSync(join(migrationsDirectory({}), "0001_initial.sql"))).toBe(true);
  });

  test("空資料庫可跑到最新 migration，並建立全部表與索引", async () => {
    await withTempHome("migrate", async (home) => {
      const db = openDatabase({ home });
      try {
        const tables = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((row) => row.name);
        for (const table of REQUIRED_TABLES) {
          expect(tables).toContain(table);
        }

        const indexes = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
          .all()
          .map((row) => row.name);
        for (const index of REQUIRED_INDEXES) {
          expect(indexes).toContain(index);
        }

        const migrations = db
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => row.version);
        expect(migrations).toEqual([1]);
      } finally {
        db.close();
      }
    });
  });

  test("連線啟用 WAL、busy_timeout 與 foreign_keys", async () => {
    await withTempHome("pragmas", async (home) => {
      const db = openDatabase({ home });
      try {
        const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
        expect(journal?.journal_mode).toBe("wal");
        const busy = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
        expect(busy?.timeout).toBe(15_000);
        const foreignKeys = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
        expect(foreignKeys?.foreign_keys).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  test("重複開啟不會重跑 migration", async () => {
    await withTempHome("remigrate", async (home) => {
      const first = openDatabase({ home });
      first.close();
      const second = openDatabase({ home });
      try {
        const count = second
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
          .get();
        expect(count?.count).toBe(1);
      } finally {
        second.close();
      }
    });
  });

  test("SMILEWORK_HOME 決定資料庫路徑", async () => {
    await withTempHome("env-home", async (home) => {
      const db = openDatabase({ env: { SMILEWORK_HOME: home } });
      try {
        expect(existsSync(join(home, "smilework.db"))).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  test("每個已套用的 migration 都記錄內容雜湊", async () => {
    await withTempHome("migrate-hash-recorded", async (home) => {
      const db = openDatabase({ home });
      try {
        const rows = db
          .query<{ version: number; sha256: string | null }, []>(
            "SELECT version, sha256 FROM schema_migrations ORDER BY version",
          )
          .all();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
      } finally {
        db.close();
      }
    });
  });

  test("已套用的 migration 被修改後，再次啟動會回 MIGRATION_HASH_MISMATCH", async () => {
    await withTempDir("migrate-hash-mismatch", async (dir) => {
      const migrations = join(dir, "migrations");
      mkdirSync(migrations);
      const file = join(migrations, "0001_test.sql");
      writeFileSync(file, "CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT;\n", "utf8");
      const dbPath = join(dir, "db.sqlite");

      const first = new Database(dbPath);
      migrate(first, migrations);
      first.close();

      writeFileSync(file, "CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT) STRICT;\n", "utf8");
      const second = new Database(dbPath);
      try {
        expect(() => migrate(second, migrations)).toThrow(
          expect.objectContaining({ code: "MIGRATION_HASH_MISMATCH" }),
        );
        const count = second
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
          .get();
        expect(count?.count).toBe(1);
      } finally {
        second.close();
      }
    });
  });

  test("已套用的 migration 被刪除或改名時會明確報錯", async () => {
    await withTempDir("migrate-hash-missing", async (dir) => {
      const migrations = join(dir, "migrations");
      mkdirSync(migrations);
      const file = join(migrations, "0001_test.sql");
      writeFileSync(file, "CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT;\n", "utf8");
      const dbPath = join(dir, "db.sqlite");

      const first = new Database(dbPath);
      migrate(first, migrations);
      first.close();

      renameSync(file, join(migrations, "0001_renamed.sql"));
      const second = new Database(dbPath);
      try {
        expect(() => migrate(second, migrations)).toThrow(
          expect.objectContaining({ code: "MIGRATION_RENAMED" }),
        );
      } finally {
        second.close();
      }

      unlinkSync(join(migrations, "0001_renamed.sql"));
      const third = new Database(dbPath);
      try {
        expect(() => migrate(third, migrations)).toThrow(
          expect.objectContaining({ code: "MIGRATION_FILE_MISSING" }),
        );
      } finally {
        third.close();
      }
    });
  });

  test("舊資料庫沒有雜湊時會補記目前檔案的雜湊", async () => {
    await withTempDir("migrate-hash-backfill", async (dir) => {
      const migrations = join(dir, "migrations");
      mkdirSync(migrations);
      const file = join(migrations, "0001_test.sql");
      writeFileSync(file, "CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT;\n", "utf8");
      const dbPath = join(dir, "db.sqlite");

      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT;
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (1, '0001_test.sql', '2026-01-01T00:00:00.000Z');
        `);

        expect(migrate(db, migrations)).toBe(0);
        const row = db
          .query<{ sha256: string | null }, [number]>(
            "SELECT sha256 FROM schema_migrations WHERE version = ?",
          )
          .get(1);
        expect(row?.sha256).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        db.close();
      }
    });
  });

  test("雜湊不符時不會套用後面的新 migration", async () => {
    await withTempDir("migrate-hash-stops", async (dir) => {
      const migrations = join(dir, "migrations");
      mkdirSync(migrations);
      const firstFile = join(migrations, "0001_first.sql");
      writeFileSync(firstFile, "CREATE TABLE first_table (id INTEGER PRIMARY KEY) STRICT;\n", "utf8");
      writeFileSync(
        join(migrations, "0002_second.sql"),
        "CREATE TABLE second_table (id INTEGER PRIMARY KEY) STRICT;\n",
        "utf8",
      );
      const dbPath = join(dir, "db.sqlite");

      const first = new Database(dbPath);
      migrate(first, migrations);
      first.close();

      writeFileSync(firstFile, "CREATE TABLE first_table (id INTEGER PRIMARY KEY, note TEXT) STRICT;\n", "utf8");
      writeFileSync(
        join(migrations, "0003_third.sql"),
        "CREATE TABLE third_table (id INTEGER PRIMARY KEY) STRICT;\n",
        "utf8",
      );

      const second = new Database(dbPath);
      try {
        expect(() => migrate(second, migrations)).toThrow(
          expect.objectContaining({ code: "MIGRATION_HASH_MISMATCH" }),
        );
        const tables = second
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name);
        expect(tables).not.toContain("third_table");
        const versions = second
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => row.version);
        expect(versions).toEqual([1, 2]);
      } finally {
        second.close();
      }
    });
  });

  test("外鍵限制生效，孤兒工作項目被拒絕", async () => {
    await withTempHome("foreign-key", async (home) => {
      const db = openDatabase({ home });
      try {
        expect(() =>
          db
            .query(
              `INSERT INTO work_items (work_id, project_id, kind, title, status, owner, priority, created_at, updated_at, created_by, updated_by)
               VALUES ('orphan', 'missing-project', 'task', '孤兒', 'open', 'build', 'normal', 'now', 'now', 'build', 'build')`,
            )
            .run(),
        ).toThrow();
      } finally {
        db.close();
      }
    });
  });
});
