import { describe, expect, test } from "bun:test";

import { importPackage } from "../../src/import/index.ts";
import { openDatabase } from "../../src/db/index.ts";
import { withTempHome } from "../helpers/temp.ts";
import { buildV3Package } from "./helpers.ts";

describe("重複匯入", () => {
  test("同一包匯入兩次不新增任何資料列", async () => {
    const fixture = buildV3Package({ global: true });
    try {
      await withTempHome("import-twice", async (home) => {
        const first = importPackage({ packageDir: fixture.packageDir, home });
        const db = openDatabase({ home });
        try {
          const snapshot = () => ({
            work: db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM work_items").get()!.total,
            events: db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM events").get()!.total,
            evidence: db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM evidence").get()!.total,
            signals: db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM signals").get()!.total,
            knowledge: db
              .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM knowledge_entries")
              .get()!.total,
            versions: db
              .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM knowledge_versions")
              .get()!.total,
            mappings: db
              .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM id_mappings")
              .get()!.total,
            updatedAt: db
              .query<{ updated_at: string }, [string]>(
                "SELECT updated_at FROM work_items WHERE work_id = ?",
              )
              .get("t-fixture-active")!.updated_at,
          });

          const before = snapshot();
          const second = importPackage({ packageDir: fixture.packageDir, home });
          const after = snapshot();

          expect(first.inserted.work).toBe(3);
          expect(second.inserted.work).toBe(0);
          expect(second.inserted.events).toBe(0);
          expect(second.inserted.knowledge).toBe(0);
          expect(second.inserted.knowledgeVersions).toBe(0);
          expect(after).toEqual(before);
        } finally {
          db.close();
        }
      });
    } finally {
      fixture.cleanup();
    }
  });
});
