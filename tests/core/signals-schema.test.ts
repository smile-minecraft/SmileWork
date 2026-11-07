import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { insertTestProject, withTestDatabase } from "../helpers/db.ts";

describe("signals schema", () => {
  test("保留匯入需要的 details、severity 與 code", async () => {
    await withTestDatabase(async ({ db }) => {
      const projectId = insertTestProject(db);
      const now = new Date().toISOString();
      db.query(
        `INSERT INTO signals (
           signal_id, project_id, scope, kind, content, status, work_id, refs,
           result_refs, reason, actor, actor_model, created_at, updated_at, updated_by,
           details, severity, code
         ) VALUES (?, ?, 'project', 'warning', '舊資料需要人工確認', 'open', NULL, '[]',
           '[]', NULL, 'import', NULL, ?, ?, 'import', ?, 'warning', 'MIGRATED_WARNING')`,
      ).run(
        "signal-import-1",
        projectId,
        now,
        now,
        JSON.stringify({ legacy: true }),
      );

      const row = db
        .query<{ details: string; severity: string; code: string }, []>(
          "SELECT details, severity, code FROM signals WHERE signal_id = 'signal-import-1'",
        )
        .get();

      expect(row).toEqual({
        details: JSON.stringify({ legacy: true }),
        severity: "warning",
        code: "MIGRATED_WARNING",
      });
    });
  });

  test("severity 只接受 info、warning、error", async () => {
    await withTestDatabase(async ({ db }) => {
      const projectId = insertTestProject(db);
      const now = new Date().toISOString();
      expect(() =>
        db
          .query(
            `INSERT INTO signals (
               signal_id, project_id, scope, kind, content, status, refs, result_refs,
               actor, created_at, updated_at, severity
             ) VALUES ('signal-bad-severity', ?, 'project', 'info', 'x', 'open', '[]', '[]',
               'import', ?, ?, 'fatal')`,
          )
          .run(projectId, now, now),
      ).toThrow();
    });
  });
});
