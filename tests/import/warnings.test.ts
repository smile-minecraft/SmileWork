import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ImportError } from "../../src/import/errors.ts";
import { importPackage } from "../../src/import/index.ts";
import { openDatabase } from "../../src/db/index.ts";
import { withTempHome } from "../helpers/temp.ts";
import { buildV3Package, makeTempDir } from "./helpers.ts";

function copyPackage(source: string): string {
  const target = join(makeTempDir("import-copy"), "package");
  cpSync(source, target, { recursive: true });
  return target;
}

describe("匯入警告", () => {
  test("未知欄位與損壞的 JSONL 只記警告，其他資料仍匯入", async () => {
    const fixture = buildV3Package();
    const packageDir = copyPackage(fixture.packageDir);
    try {
      appendFileSync(
        join(packageDir, "work.jsonl"),
        `${JSON.stringify({
          kind: "task",
          owner: "tester",
          priority: "medium",
          status: "open",
          title: "帶未知欄位的工作",
          workId: "t-unknown-field",
          mystery: { nested: true },
        })}\n`,
        "utf8",
      );
      appendFileSync(join(packageDir, "work.jsonl"), "{ 這不是 JSON\n", "utf8");
      appendFileSync(
        join(packageDir, "events.jsonl"),
        '{"actor":"tester","eventId":"e-broken","kind":"status_changed","sequence":99,"workId":"t-unknown-field","toStatus":"open","extra":1}\n',
        "utf8",
      );

      await withTempHome("import-warnings", async (home) => {
        const result = importPackage({ packageDir, home });

        expect(result.inserted.work).toBe(4);
        expect(result.inserted.events).toBe(9);
        expect(
          result.warnings.some((warning) => warning.includes("UNKNOWN_FIELD") && warning.includes("mystery")),
        ).toBe(true);
        expect(
          result.warnings.some(
            (warning) => warning.includes("MALFORMED_JSON") && warning.includes("work.jsonl"),
          ),
        ).toBe(true);
        expect(
          result.warnings.some(
            (warning) => warning.includes("UNKNOWN_FIELD") && warning.includes("extra"),
          ),
        ).toBe(true);
        expect(
          result.warnings.some((warning) => warning.includes("LAYOUT_COUNT_MISMATCH")),
        ).toBe(true);

        const db = openDatabase({ home });
        try {
          const work = db
            .query<{ title: string }, [string]>("SELECT title FROM work_items WHERE work_id = ?")
            .get("t-unknown-field");
          expect(work?.title).toBe("帶未知欄位的工作");
          const event = db
            .query<{ sequence: number }, [string]>("SELECT sequence FROM events WHERE event_id = ?")
            .get("e-broken");
          expect(event?.sequence).toBe(99);
        } finally {
          db.close();
        }
      });
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  test("缺少 manifest 時回報明確錯誤", async () => {
    const fixture = buildV3Package();
    const packageDir = copyPackage(fixture.packageDir);
    try {
      rmSync(join(packageDir, "manifest.json"));
      await withTempHome("import-no-manifest", async (home) => {
        expect(() => importPackage({ packageDir, home })).toThrow(ImportError);
        try {
          importPackage({ packageDir, home });
        } catch (error) {
          expect((error as ImportError).code).toBe("MANIFEST_MISSING");
        }
      });
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  test("不支援的 formatVersion 在讀取內容前拒絕", async () => {
    const fixture = buildV3Package();
    const packageDir = copyPackage(fixture.packageDir);
    try {
      const manifestPath = join(packageDir, "manifest.json");
      const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
      manifest.formatVersion = 2;
      await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await withTempHome("import-version", async (home) => {
        try {
          importPackage({ packageDir, home });
          throw new Error("應該要拒絕");
        } catch (error) {
          expect(error).toBeInstanceOf(ImportError);
          expect((error as ImportError).code).toBe("UNSUPPORTED_FORMAT_VERSION");
        }
      });
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
