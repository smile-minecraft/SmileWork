import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { insertTestProject, insertTestWorkItem, withTestDatabase } from "../helpers/db.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const worker = join(repoRoot, "tests", "helpers", "optimistic-worker.ts");

describe("樂觀鎖並行更新", () => {
  test("三個程序同時以 expectedVersion 更新同一列，只有一個成功", async () => {
    await withTestDatabase(async ({ db, dbPath }) => {
      const projectId = insertTestProject(db);
      const workId = insertTestWorkItem(db, { projectId, version: 1 });

      const children = Array.from({ length: 3 }, () =>
        Bun.spawn([process.execPath, worker, dbPath, workId, "1"], {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        }),
      );

      const outputs = await Promise.all(
        children.map(async (child) => {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(exitCode).toBe(0);
          expect(stderr).toBe("");
          return JSON.parse(stdout.trim()) as { updated: boolean; currentVersion: number | null };
        }),
      );

      expect(outputs.filter((result) => result.updated)).toHaveLength(1);
      expect(outputs.filter((result) => !result.updated)).toHaveLength(2);
      for (const result of outputs.filter((entry) => !entry.updated)) {
        expect(result.currentVersion).toBe(2);
      }

      const row = db.query<{ version: number }, []>(
        `SELECT version FROM work_items WHERE work_id = '${workId}'`,
      ).get();
      expect(row?.version).toBe(2);
    });
  }, 30_000);
});
