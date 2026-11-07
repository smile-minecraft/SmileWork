import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { importPackage } from "../../src/import/index.ts";
import { openDatabase } from "../../src/db/index.ts";
import { withTempHome } from "../helpers/temp.ts";
import { buildV3Package, readJson, readJsonLines } from "./helpers.ts";

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  const row = db.query<{ total: number }, []>(`SELECT COUNT(*) AS total FROM ${table}`).get();
  return row?.total ?? 0;
}

describe("匯入資料庫", () => {
  test("建立工作、事件、訊號、知識、版本與舊 ID 對應", async () => {
    const fixture = buildV3Package({ global: true });
    try {
      await withTempHome("import-full", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home });
        expect(result.dryRun).toBe(false);
        expect(result.inserted.work).toBe(3);
        expect(result.inserted.events).toBe(8);
        expect(result.inserted.knowledge).toBe(2);
        expect(result.inserted.knowledgeVersions).toBe(2);

        const db = openDatabase({ home });
        try {
          expect(db.query<{ project_id: string }, []>("SELECT project_id FROM projects").all()).toEqual([
            { project_id: "project" },
          ]);
          expect(count(db, "work_items")).toBe(3);
          expect(count(db, "work_dependencies")).toBe(0);
          expect(count(db, "events")).toBe(8);
          expect(count(db, "evidence")).toBe(0);
          expect(count(db, "signals")).toBe(0);
          expect(count(db, "knowledge_entries")).toBe(2);
          expect(count(db, "knowledge_versions")).toBe(2);

          const works = db
            .query<{ work_id: string; title: string; status: string; plan_id: string | null }, []>(
              "SELECT work_id, title, status, plan_id FROM work_items ORDER BY work_id",
            )
            .all();
          expect(works.map((work) => work.work_id)).toEqual([
            "p-fixture-20261007",
            "t-fixture-active",
            "t-fixture-done",
          ]);
          expect(works.find((work) => work.work_id === "t-fixture-active")?.plan_id).toBe(
            "p-fixture-20261007",
          );

          const mappings = db
            .query<{ entity: string; source_id: string; target_id: string }, []>(
              "SELECT entity, source_id, target_id FROM id_mappings ORDER BY entity, source_id",
            )
            .all();
          const activeMapping = mappings.find(
            (mapping) =>
              mapping.entity === "work" && mapping.source_id.endsWith("\u0000t-fixture-active"),
          );
          expect(activeMapping?.target_id).toBe("t-fixture-active");
          expect(mappings.some((mapping) => mapping.entity === "raw")).toBe(true);

          const version = db
            .query<{ snapshot_path: string; sha256: string }, []>(
              "SELECT snapshot_path, sha256 FROM knowledge_versions ORDER BY version LIMIT 1",
            )
            .get();
          expect(version?.snapshot_path).toBeDefined();
          const snapshotPath = isAbsolute(version!.snapshot_path)
            ? version!.snapshot_path
            : join(home, version!.snapshot_path);
          expect(existsSync(snapshotPath)).toBe(true);

          const expected = readJsonLines(join(fixture.packageDir, "work.jsonl"));
          const active = expected.find((record) => record.workId === "t-fixture-active")!;
          const row = db
            .query<{ title: string; status: string }, [string]>(
              "SELECT title, status FROM work_items WHERE work_id = ?",
            )
            .get("t-fixture-active");
          expect(row?.title).toBe(String(active.title));
          expect(row?.status).toBe(String(active.status));

          const manifest = readJson(join(fixture.packageDir, "manifest.json"));
          expect((manifest.source as { layers: string[] }).layers).toContain("global");
        } finally {
          db.close();
        }
      });
    } finally {
      fixture.cleanup();
    }
  });
});
