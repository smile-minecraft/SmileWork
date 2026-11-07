import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { openDatabase } from "../../src/db/index.ts";
import { exportCurrent } from "../../src/export/current/index.ts";
import { importPackage } from "../../src/import/index.ts";
import { insertTestProject } from "../helpers/db.ts";
import { validatePackage } from "../export-format/helpers/package.ts";
import {
  FIXED_CREATED_AT,
  makeTempDir,
  readJsonLines,
  removeDir,
  scanHashes,
  sha256Bytes,
} from "./helpers.ts";

interface KnowledgeSeed {
  layer: "project" | "global";
  title: string;
  body: string;
}

function insertKnowledge(
  db: ReturnType<typeof openDatabase>,
  home: string,
  projectId: string,
  seed: KnowledgeSeed,
): void {
  const now = new Date().toISOString();
  const projectScope = seed.layer === "global" ? null : projectId;
  const result = db
    .query(
      `INSERT INTO knowledge_entries (
         knowledge_id, layer, project_id, kind, type, title, description, pinned,
         source, tags, status, current_version, version, work_id,
         created_at, updated_at, created_by, created_by_model, updated_by, updated_by_model
       ) VALUES ('dup', ?, ?, 'memory', 'decision', ?, ?, 0, 'manual', ?, 'active', 1, 1, NULL, ?, ?, 'test', NULL, 'test', NULL)`,
    )
    .run(
      seed.layer,
      projectScope,
      seed.title,
      `${seed.title} 說明`,
      JSON.stringify([seed.layer]),
      now,
      now,
    );
  const snapshotPath = join(home, "knowledge-store", seed.layer, `dup-${seed.layer}.md`);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const bytes = Buffer.from(seed.body, "utf8");
  writeFileSync(snapshotPath, bytes);
  db.query(
    `INSERT INTO knowledge_versions (
       entry_id, version, sha256, bytes, snapshot_path, actor, actor_model,
       reason, source_signal_ids, work_id, created_at
     ) VALUES (?, 1, ?, ?, ?, 'test', NULL, NULL, '[]', NULL, ?)`,
  ).run(result.lastInsertRowid, sha256Bytes(bytes), bytes.byteLength, snapshotPath, now);
}

describe("跨層同名知識匯出", () => {
  test("project 與 global 同 knowledgeId 時保留兩筆，並配置唯一 ID 與 mapping", async () => {
    const root = makeTempDir("knowledge-collision");
    const home = join(root, "home", ".smilework");
    const firstOut = join(root, "export-1");
    const secondOut = join(root, "export-2");
    try {
      const db = openDatabase({ home });
      try {
        const projectId = insertTestProject(db, "collision-project");
        insertKnowledge(db, home, projectId, {
          layer: "project",
          title: "專案版本",
          body: "## 專案內容\n",
        });
        insertKnowledge(db, home, projectId, {
          layer: "global",
          title: "全域版本",
          body: "## 全域內容\n",
        });
      } finally {
        db.close();
      }

      const first = exportCurrent({
        outDir: firstOut,
        home,
        createdAt: FIXED_CREATED_AT,
      });
      const validated = validatePackage(firstOut);

      const knowledge = readJsonLines(join(firstOut, "knowledge", "index.jsonl"));
      expect(knowledge).toHaveLength(2);
      const ids = knowledge.map((entry) => entry.knowledgeId);
      expect(new Set(ids).size).toBe(2);
      const project = knowledge.find((entry) => entry.layer === "project");
      const global = knowledge.find((entry) => entry.layer === "global");
      expect(project?.knowledgeId).toBe("dup");
      expect(project?.title).toBe("專案版本");
      expect(global?.knowledgeId).toBe("global-dup");
      expect(global?.title).toBe("全域版本");
      expect(readFileSync(join(firstOut, "knowledge", "files", "dup", "v1.md"), "utf8")).toBe(
        "## 專案內容\n",
      );
      expect(
        readFileSync(join(firstOut, "knowledge", "files", "global-dup", "v1.md"), "utf8"),
      ).toBe("## 全域內容\n");

      const mapping = readJsonLines(join(firstOut, "mapping.jsonl")).find(
        (record) =>
          record.entity === "knowledge" &&
          record.layer === "global" &&
          record.sourceId === "dup",
      );
      expect(mapping?.targetId).toBe("global-dup");
      expect(mapping?.sourceRoot).toBe("raw/global");
      expect(validated.manifest.warnings.some((warning) => warning.includes("dup"))).toBe(true);

      const second = exportCurrent({
        outDir: secondOut,
        home,
        createdAt: FIXED_CREATED_AT,
      });
      expect(second.manifest.layout).toEqual(first.manifest.layout);
      expect(scanHashes(secondOut)).toEqual(scanHashes(firstOut));

      const secondHome = join(root, "second-home", ".smilework");
      importPackage({ packageDir: firstOut, home: secondHome });
      const imported = openDatabase({ home: secondHome });
      try {
        const rows = imported
          .query<{ knowledge_id: string; layer: string }, []>(
            "SELECT knowledge_id, layer FROM knowledge_entries ORDER BY layer, knowledge_id",
          )
          .all();
        expect(rows).toEqual([
          { knowledge_id: "global-dup", layer: "global" },
          { knowledge_id: "dup", layer: "project" },
        ]);
      } finally {
        imported.close();
      }
    } finally {
      removeDir(root);
    }
  });
});
