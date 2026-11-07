import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exportCurrent } from "../../src/export/current/index.ts";
import { importPackage } from "../../src/import/index.ts";
import { validatePackage } from "../export-format/helpers/package.ts";
import { withTempHome } from "../helpers/temp.ts";
import {
  FIXED_CREATED_AT,
  buildV3Package,
  listFiles,
  readJson,
  readJsonLines,
  scanHashes,
} from "./helpers.ts";

function sortedById(
  records: readonly Record<string, unknown>[],
  key: string,
): Record<string, unknown>[] {
  return [...records].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

describe("匯出目前資料庫", () => {
  test("舊資料匯出、匯入、再匯出後 work/events/knowledge 內容相同", async () => {
    const fixture = buildV3Package({ global: true });
    try {
      const sourceHashes = scanHashes(fixture.projectSource);
      const packageHashes = scanHashes(fixture.packageDir);

      await withTempHome("import-roundtrip", async (home, root) => {
        importPackage({ packageDir: fixture.packageDir, home });
        const result = exportCurrent({
          outDir: join(root, "export"),
          home,
          createdAt: FIXED_CREATED_AT,
        });

        const validated = validatePackage(result.outDir);
        expect(validated.manifest.source.kind).toBe("smilework-db");
        expect(validated.manifest.source.projectId).toBe("project");
        expect(validated.manifest.source.layers).toContain("global");

        expect(sortedById(readJsonLines(join(result.outDir, "work.jsonl")), "workId")).toEqual(
          sortedById(readJsonLines(join(fixture.packageDir, "work.jsonl")), "workId"),
        );
        expect(sortedById(readJsonLines(join(result.outDir, "events.jsonl")), "eventId")).toEqual(
          sortedById(readJsonLines(join(fixture.packageDir, "events.jsonl")), "eventId"),
        );

        const originalKnowledge = readJsonLines(
          join(fixture.packageDir, "knowledge", "index.jsonl"),
        );
        const exportedKnowledge = readJsonLines(join(result.outDir, "knowledge", "index.jsonl"));
        expect(sortedById(exportedKnowledge, "knowledgeId")).toEqual(
          sortedById(originalKnowledge, "knowledgeId"),
        );
        for (const entry of originalKnowledge) {
          const knowledgeId = String(entry.knowledgeId);
          for (const version of entry.versions as Array<{ version: number }>) {
            const relative = `knowledge/files/${knowledgeId}/v${version.version}.md`;
            expect(readFileSync(join(result.outDir, relative))).toEqual(
              readFileSync(join(fixture.packageDir, relative)),
            );
          }
        }

        expect(readJsonLines(join(result.outDir, "evidence.jsonl"))).toEqual([]);
        expect(readJsonLines(join(result.outDir, "signals.jsonl"))).toEqual([]);
        expect(listFiles(join(result.outDir, "raw", "project"))).toEqual(
          listFiles(join(fixture.packageDir, "raw", "project")),
        );
      });

      expect(scanHashes(fixture.projectSource)).toEqual(sourceHashes);
      expect(scanHashes(fixture.packageDir)).toEqual(packageHashes);
      expect(readJson(join(fixture.packageDir, "manifest.json")).format).toBe("smilework-export");
    } finally {
      fixture.cleanup();
    }
  });
});
