import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrationsDirectory, openDatabase } from "../../src/db/index.ts";
import { withTempHome } from "../helpers/temp.ts";

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
