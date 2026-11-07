import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { openDatabase } from "../../src/db/index.ts";
import { exportCurrent } from "../../src/export/current/index.ts";
import { importPackage } from "../../src/import/index.ts";
import { relinkProject, resolveProject } from "../../src/project/index.ts";
import { validatePackage } from "../export-format/helpers/package.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";
import {
  FIXED_CREATED_AT,
  buildV3Package,
  makeTempDir,
  removeDir,
} from "./helpers.ts";

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  return db.query<{ total: number }, []>(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total;
}

describe("專案重新對應與匯入對應", () => {
  test("import → relink → export 後 raw 與 mapping 不遺失，而且可以再匯入", async () => {
    const fixture = buildV3Package();
    const secondHome = makeTempDir("relink-second-home");
    try {
      const sourcePackage = validatePackage(fixture.packageDir);
      await withTempDir("relink-import", async (root) => {
        const home = join(root, "home", ".smilework");
        const repo = await createGitRepo(join(root, "repo"));
        importPackage({ packageDir: fixture.packageDir, home });

        const beforeDb = openDatabase({ home });
        let before: { work: number; events: number; mappings: number };
        let oldProjectId: string;
        try {
          oldProjectId = beforeDb
            .query<{ project_id: string }, []>("SELECT project_id FROM projects")
            .get()!.project_id;
          before = {
            work: count(beforeDb, "work_items"),
            events: count(beforeDb, "events"),
            mappings: count(beforeDb, "id_mappings"),
          };
        } finally {
          beforeDb.close();
        }

        const db = openDatabase({ home });
        try {
          const relinked = relinkProject(db, {
            newPath: repo,
            projectId: oldProjectId,
          });
          expect(relinked.previousProjectId).toBe(oldProjectId);
          expect(relinked.projectId).not.toBe(oldProjectId);

          expect({
            work: count(db, "work_items"),
            events: count(db, "events"),
            mappings: count(db, "id_mappings"),
          }).toEqual(before);

          const mappings = db
            .query<{ entity: string; layer: string; source_id: string; source_root: string }, []>(
              "SELECT entity, layer, source_id, source_root FROM id_mappings",
            )
            .all();
          expect(mappings.length).toBeGreaterThan(0);
          for (const mapping of mappings) {
            expect(mapping.source_root).toBe(relinked.projectId);
            expect(mapping.source_id.startsWith(`${relinked.projectId}\u0000`)).toBe(true);
          }
          const projects = db
            .query<{ project_id: string }, []>("SELECT project_id FROM projects")
            .all();
          expect(projects).toEqual([{ project_id: relinked.projectId }]);

          const outDir = join(root, "export");
          const exported = exportCurrent({
            outDir,
            home,
            createdAt: FIXED_CREATED_AT,
          });
          const validated = validatePackage(outDir);
          expect(validated.manifest.source.projectId).toBe(relinked.projectId);
          expect(validated.rawFiles).toEqual(sourcePackage.rawFiles);
          expect(validated.manifest.layout.mapping.records).toBe(
            sourcePackage.manifest.layout.mapping.records,
          );
          expect(exported.manifest.layout.work.records).toBe(before.work);
          expect(exported.manifest.layout.events.records).toBe(before.events);

          const againHome = join(secondHome, "home", ".smilework");
          const imported = importPackage({ packageDir: outDir, home: againHome });
          expect(imported.inserted.work).toBe(before.work);
          expect(imported.inserted.raw).toBeGreaterThan(0);
          expect(imported.inserted.mapping).toBeGreaterThan(0);
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(secondHome);
      fixture.cleanup();
    }
  });

  test("id_mappings 主鍵衝突時整筆 relink 回滾並回報", async () => {
    const fixture = buildV3Package();
    try {
      await withTempDir("relink-conflict", async (root) => {
        const home = join(root, "home", ".smilework");
        const repo = await createGitRepo(join(root, "repo"));
        importPackage({ packageDir: fixture.packageDir, home });

        const nextProjectId = resolveProject({ explicitPath: repo }).projectId;
        const db = openDatabase({ home });
        try {
          const oldProjectId = db
            .query<{ project_id: string }, []>("SELECT project_id FROM projects")
            .get()!.project_id;
          const oldSource = db
            .query<{ source_id: string }, []>(
              "SELECT source_id FROM id_mappings WHERE entity = 'work' LIMIT 1",
            )
            .get()!.source_id;
          const original = oldSource.slice(`${oldProjectId}\u0000`.length);
          const now = new Date().toISOString();
          db.query(
            `INSERT INTO id_mappings (entity, layer, source_id, source_root, target_id, imported_at)
             VALUES ('work', 'project', ?, ?, 'conflict-target', ?)`,
          ).run(`${nextProjectId}\u0000${original}`, nextProjectId, now);

          try {
            relinkProject(db, { newPath: repo, projectId: oldProjectId });
            throw new Error("應該要回報 id_mappings 主鍵衝突");
          } catch (error) {
            expect((error as { code?: string }).code).toBe("ID_MAPPING_CONFLICT");
          }

          const project = db
            .query<{ project_id: string }, []>("SELECT project_id FROM projects")
            .get();
          expect(project?.project_id).toBe(oldProjectId);
          expect(count(db, "project_worktrees")).toBe(0);
          const oldMapping = db
            .query<{ source_root: string; source_id: string }, [string]>(
              "SELECT source_root, source_id FROM id_mappings WHERE source_id = ?",
            )
            .get(oldSource);
          expect(oldMapping?.source_root).toBe(oldProjectId);
          expect(oldMapping?.source_id).toBe(oldSource);
          const conflict = db
            .query<{ source_root: string }, [string]>(
              "SELECT source_root FROM id_mappings WHERE source_id = ?",
            )
            .get(`${nextProjectId}\u0000${original}`);
          expect(conflict?.source_root).toBe(nextProjectId);
        } finally {
          db.close();
        }
      });
    } finally {
      fixture.cleanup();
    }
  });
});
