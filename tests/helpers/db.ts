import type { Database } from "bun:sqlite";
import { openDatabase } from "../../src/db/index.ts";
import { withTempHome } from "./temp.ts";

export interface TestDbContext {
  home: string;
  root: string;
  dbPath: string;
  db: Database;
}

/** 在暫存 home 建立已 migration 的資料庫，結束後關閉並刪除。 */
export async function withTestDatabase<T>(
  run: (context: TestDbContext) => T | Promise<T>,
): Promise<T> {
  return withTempHome("db", async (home, root) => {
    const db = openDatabase({ home });
    try {
      const dbPath = db.filename;
      return await run({ home, root, dbPath, db });
    } finally {
      db.close();
    }
  });
}

/** 建立專案資料列，讓需要外鍵的測試可以插入工作項目。 */
export function insertTestProject(db: Database, projectId = "test-project"): string {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO projects (project_id, common_dir, root_path, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, `/tmp/${projectId}/.git`, `/tmp/${projectId}`, now, now, now);
  return projectId;
}

export function insertTestWorkItem(
  db: Database,
  options: { projectId?: string; workId?: string; status?: string; version?: number } = {},
): string {
  const projectId = options.projectId ?? insertTestProject(db);
  const workId = options.workId ?? "work-test-1";
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO work_items (
       work_id, project_id, kind, title, status, owner, priority, version,
       created_at, updated_at, created_by, updated_by
     ) VALUES (?, ?, 'task', '測試工作', ?, 'build', 'normal', ?, ?, ?, 'build', 'build')`,
  ).run(workId, projectId, options.status ?? "open", options.version ?? 1, now, now);
  return workId;
}
