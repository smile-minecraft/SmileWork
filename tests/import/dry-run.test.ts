import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { importPackage } from "../../src/import/index.ts";
import { openDatabase } from "../../src/db/index.ts";
import { withTempHome } from "../helpers/temp.ts";
import { buildV3Package } from "./helpers.ts";

const repoRoot = `${import.meta.dir}/../..`;

describe("匯入乾跑", () => {
  test("只回報計數，不建立資料庫或家目錄", async () => {
    const fixture = buildV3Package();
    try {
      await withTempHome("import-dry", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home, dryRun: true });

        expect(result.dryRun).toBe(true);
        expect(result.counts.work).toBe(3);
        expect(result.counts.events).toBe(8);
        expect(result.counts.evidence).toBe(0);
        expect(result.counts.signals).toBe(0);
        expect(result.counts.knowledge).toBe(1);
        expect(result.counts.knowledgeVersions).toBe(1);
        expect(result.counts.mapping).toBe(21);
        expect(result.counts.raw).toBe(9);
        expect(result.inserted.work).toBe(0);
        expect(existsSync(home)).toBe(false);
        expect(existsSync(join(home, "smilework.db"))).toBe(false);
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("資料庫已存在時，乾跑不改變任何資料表計數", async () => {
    const fixture = buildV3Package();
    try {
      await withTempHome("import-dry-existing", async (home) => {
        importPackage({ packageDir: fixture.packageDir, home });
        const db = openDatabase({ home });
        try {
          const count = (table: string): number =>
            db.query<{ total: number }, []>(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total;
          const before = {
            work: count("work_items"),
            events: count("events"),
            evidence: count("evidence"),
            signals: count("signals"),
            knowledge: count("knowledge_entries"),
            versions: count("knowledge_versions"),
            mappings: count("id_mappings"),
          };
          const result = importPackage({
            packageDir: fixture.packageDir,
            home,
            dryRun: true,
          });
          expect(result.inserted.work).toBe(0);
          expect({
            work: count("work_items"),
            events: count("events"),
            evidence: count("evidence"),
            signals: count("signals"),
            knowledge: count("knowledge_entries"),
            versions: count("knowledge_versions"),
            mappings: count("id_mappings"),
          }).toEqual(before);
        } finally {
          db.close();
        }
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("CLI 的 --dry-run 以 0 結束並列出計數，且不寫資料庫", async () => {
    const fixture = buildV3Package();
    try {
      await withTempHome("import-dry-cli", async (home) => {
        const child = Bun.spawn(
          [process.execPath, "src/cli/index.ts", "import", fixture.packageDir, "--dry-run"],
          {
            cwd: repoRoot,
            env: { ...process.env, SMILEWORK_HOME: home },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("work 3");
        expect(stdout).toContain("events 8");
        expect(stdout).toContain("乾跑");
        expect(stderr).not.toContain("import：");
        expect(existsSync(join(home, "smilework.db"))).toBe(false);
      });
    } finally {
      fixture.cleanup();
    }
  });
});
