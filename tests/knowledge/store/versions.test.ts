import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createKnowledgeEntry,
  readKnowledgeVersion,
  updateKnowledgeEntry,
} from "../../../src/knowledge/store.ts";
import {
  diffKnowledgeVersions,
  listKnowledgeVersions,
  restoreKnowledgeVersion,
  writeKnowledgeSnapshot,
} from "../../../src/knowledge/versions.ts";
import { insertTestProject, withTestDatabase } from "../../helpers/db.ts";

function storeOptions(home: string): { env: NodeJS.ProcessEnv } {
  return { env: { SMILEWORK_HOME: home } };
}

function createEntry(db: Database, home: string, knowledgeId: string, content: string) {
  return createKnowledgeEntry(
    db,
    {
      knowledgeId,
      layer: "project",
      projectId: "test-project",
      kind: "memory",
      type: "lesson",
      title: knowledgeId,
      description: "",
      content,
      actor: "build",
    },
    storeOptions(home),
  );
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files.sort();
}

describe("digest 去重", () => {
  test("相同內容只留一份快照，但每個版本都有記錄", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const content = "共用的內容\n";
      const first = createEntry(db, home, "k-dedupe-a", content);
      const sameEntry = updateKnowledgeEntry(
        db,
        first.id,
        { content, actor: "build", reason: "重寫相同內容" },
        storeOptions(home),
      );
      const second = createEntry(db, home, "k-dedupe-b", content);

      const firstVersions = listKnowledgeVersions(db, first.id);
      const secondVersions = listKnowledgeVersions(db, second.id);
      expect(firstVersions.map((version) => version.version)).toEqual([1, 2]);
      expect(secondVersions.map((version) => version.version)).toEqual([1]);
      expect(sameEntry.currentVersion).toBe(2);

      const all = [...firstVersions, ...secondVersions];
      expect(all).toHaveLength(3);
      expect(new Set(all.map((version) => version.sha256)).size).toBe(1);
      expect(new Set(all.map((version) => version.snapshotPath)).size).toBe(1);

      expect(markdownFiles(join(home, "knowledge-store"))).toHaveLength(1);
    });
  });

  test("相同內容重複寫入快照不會改動既有檔案", async () => {
    await withTestDatabase(async ({ home }) => {
      const options = storeOptions(home);
      const first = writeKnowledgeSnapshot("同一份內容", options);
      const path = join(home, "knowledge-store", first.snapshotPath);
      const before = readFileSync(path, "utf8");

      const second = writeKnowledgeSnapshot("同一份內容", options);
      expect(second).toEqual(first);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });
});

describe("版本 diff", () => {
  test("diff 顯示被移除與新增的行", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createEntry(db, home, "k-diff", "第一行\n舊內容\n第三行\n");
      updateKnowledgeEntry(
        db,
        entry.id,
        { content: "第一行\n新內容\n第三行\n", actor: "build" },
        storeOptions(home),
      );

      const diff = diffKnowledgeVersions(db, entry.id, 2, storeOptions(home));
      expect(diff.previousVersion).toBe(1);
      expect(diff.diff).toContain("-舊內容");
      expect(diff.diff).toContain("+新內容");
      expect(diff.diff).toContain(" 第一行");
      expect(diff.diff).toContain("@@");

      const firstDiff = diffKnowledgeVersions(db, entry.id, 1, storeOptions(home));
      expect(firstDiff.previousVersion).toBeNull();
      expect(firstDiff.diff).toContain("+第一行");
    });
  });
});

describe("還原版本", () => {
  test("還原會建立新版本，內容與來源版本逐位元組相同", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const original = "第一版\n含中文與 emoji 🚀\n";
      const entry = createEntry(db, home, "k-restore", original);
      updateKnowledgeEntry(
        db,
        entry.id,
        { content: "第二版\n完全不同\n", actor: "build" },
        storeOptions(home),
      );

      const before = listKnowledgeVersions(db, entry.id);
      const source = before[0]!;
      const restored = restoreKnowledgeVersion(
        db,
        { entryId: entry.id, version: 1, actor: "build", reason: "回到第一版" },
        storeOptions(home),
      );

      expect(restored.entry.currentVersion).toBe(3);
      expect(restored.version.version).toBe(3);
      expect(restored.version.reason).toBe("回到第一版");
      expect(restored.version.sha256).toBe(source.sha256);

      const versions = listKnowledgeVersions(db, entry.id);
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);

      const restoredContent = readKnowledgeVersion(db, entry.id, 3, storeOptions(home)).content;
      expect(restoredContent).toBe(original);

      const sourceBytes = readFileSync(join(home, "knowledge-store", source.snapshotPath));
      const restoredBytes = readFileSync(
        join(home, "knowledge-store", restored.version.snapshotPath),
      );
      expect(Buffer.compare(sourceBytes, restoredBytes)).toBe(0);

      const untouched = readKnowledgeVersion(db, entry.id, 2, storeOptions(home)).content;
      expect(untouched).toBe("第二版\n完全不同\n");
    });
  });

  test("還原不存在的版本回清楚的錯誤", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createEntry(db, home, "k-restore-missing", "內容");
      expect(() =>
        restoreKnowledgeVersion(
          db,
          { entryId: entry.id, version: 9, actor: "build" },
          storeOptions(home),
        ),
      ).toThrow(/版本/);
    });
  });
});

describe("快照完整性", () => {
  test("快照被改動時讀取會回 digest 不符", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createEntry(db, home, "k-tamper", "原始內容");
      const version = listKnowledgeVersions(db, entry.id)[0]!;
      writeFileSync(join(home, "knowledge-store", version.snapshotPath), "被改過的內容");

      expect(() => readKnowledgeVersion(db, entry.id, 1, storeOptions(home))).toThrow(/digest/);
    });
  });
});
