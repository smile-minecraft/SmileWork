import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createKnowledgeEntry,
  findKnowledgeEntry,
  getKnowledgeEntry,
  getKnowledgeUsageStats,
  readKnowledgeEntry,
  readKnowledgeVersion,
  setKnowledgeEntryStatus,
  updateKnowledgeEntry,
} from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { SmileworkError } from "../../../src/shared/errors.ts";
import { insertTestProject, withTestDatabase } from "../../helpers/db.ts";

function storeOptions(home: string): { env: NodeJS.ProcessEnv } {
  return { env: { SMILEWORK_HOME: home } };
}

const initialContent = "# 第一版\n\n內容";

function createDecision(
  db: Database,
  home: string,
  overrides: Partial<Parameters<typeof createKnowledgeEntry>[1]> = {},
) {
  return createKnowledgeEntry(
    db,
    {
      knowledgeId: "k-store-lifecycle",
      layer: "project",
      projectId: "test-project",
      kind: "memory",
      type: "decision",
      title: "知識儲存測試",
      description: "驗證版本鏈與讀取",
      tags: ["beta", "alpha", "beta"],
      content: initialContent,
      actor: "build",
      actorModel: "test-model",
      reason: "初始版本",
      sourceSignalIds: ["signal-1"],
      ...overrides,
    },
    storeOptions(home),
  );
}

describe("知識項目與第一版", () => {
  test("建立 entry 時同步寫入第一版與快照檔", async () => {
    await withTestDatabase(async ({ db, home }) => {
      const projectId = insertTestProject(db);
      const entry = createDecision(db, home, { projectId });

      expect(entry.id).toBeGreaterThan(0);
      expect(entry.knowledgeId).toBe("k-store-lifecycle");
      expect(entry.layer).toBe("project");
      expect(entry.projectId).toBe(projectId);
      expect(entry.currentVersion).toBe(1);
      expect(entry.version).toBe(1);
      expect(entry.status).toBe("active");
      expect(entry.tags).toEqual(["alpha", "beta"]);

      const versions = listKnowledgeVersions(db, entry.id);
      expect(versions).toHaveLength(1);
      const first = versions[0]!;
      expect(first.version).toBe(1);
      expect(first.actor).toBe("build");
      expect(first.actorModel).toBe("test-model");
      expect(first.reason).toBe("初始版本");
      expect(first.sourceSignalIds).toEqual(["signal-1"]);
      expect(first.bytes).toBe(Buffer.byteLength(initialContent, "utf8"));

      const snapshot = join(home, "knowledge-store", first.snapshotPath);
      expect(existsSync(snapshot)).toBe(true);
      expect(readFileSync(snapshot, "utf8")).toBe(initialContent);
    });
  });

  test("同一 scope 重複建立 knowledgeId 會被拒絕", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      createDecision(db, home);
      expect(() => createDecision(db, home)).toThrow(/已經存在/);
    });
  });
});

describe("更新版本與讀取", () => {
  test("更新產生第二版，舊版仍可讀", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createDecision(db, home);
      const updated = updateKnowledgeEntry(
        db,
        entry.id,
        {
          content: "# 第二版\n\n改過的內容",
          actor: "build",
          actorModel: "test-model",
          reason: "補充內容",
          expectedVersion: 1,
        },
        storeOptions(home),
      );

      expect(updated.currentVersion).toBe(2);
      expect(updated.version).toBe(2);

      const versions = listKnowledgeVersions(db, entry.id);
      expect(versions.map((version) => version.version)).toEqual([1, 2]);

      const first = readKnowledgeVersion(db, entry.id, 1, storeOptions(home));
      expect(first.content).toBe(initialContent);
      expect(first.version.reason).toBe("初始版本");

      const current = readKnowledgeEntry(db, entry.id, storeOptions(home));
      expect(current.version.version).toBe(2);
      expect(current.content).toBe("# 第二版\n\n改過的內容");
      expect(current.entry.currentVersion).toBe(2);
    });
  });

  test("expectedVersion 不符時回版本衝突", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createDecision(db, home);
      updateKnowledgeEntry(
        db,
        entry.id,
        { content: "第二版", actor: "build", expectedVersion: 1 },
        storeOptions(home),
      );

      try {
        updateKnowledgeEntry(
          db,
          entry.id,
          { content: "第三版", actor: "build", expectedVersion: 1 },
          storeOptions(home),
        );
        throw new Error("應該要回版本衝突");
      } catch (error) {
        expect(error).toBeInstanceOf(SmileworkError);
        expect((error as SmileworkError).code).toBe("VERSION_CONFLICT");
        expect((error as SmileworkError).data).toMatchObject({
          entryId: entry.id,
          expectedVersion: 1,
          actualVersion: 2,
        });
      }
    });
  });

  test("每次讀取都記一筆 usage event，統計次數增加", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createDecision(db, home);

      readKnowledgeVersion(db, entry.id, 1, { ...storeOptions(home), actor: "reader" });
      readKnowledgeEntry(db, entry.id, { ...storeOptions(home), actor: "reader" });
      readKnowledgeEntry(db, entry.id, {
        ...storeOptions(home),
        actor: "reader",
        recordUsage: false,
      });

      const stats = getKnowledgeUsageStats(db, entry.id);
      expect(stats.readCount).toBe(2);
      expect(stats.lastReadAt).not.toBeNull();

      const usage = db
        .query<{ action: string; actor: string; knowledge_id: string; version: number }, []>(
          "SELECT action, actor, knowledge_id, version FROM usage_events ORDER BY created_at, usage_id",
        )
        .all();
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({ action: "read", actor: "reader", knowledge_id: entry.knowledgeId });
      expect(usage[0]?.version).toBe(1);
    });
  });

  test("退役只改狀態與列版本，不新增內容版本", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createDecision(db, home);
      const retired = setKnowledgeEntryStatus(db, entry.id, {
        status: "retired",
        actor: "build",
        expectedVersion: 1,
      });

      expect(retired.status).toBe("retired");
      expect(retired.currentVersion).toBe(1);
      expect(retired.version).toBe(2);
      expect(listKnowledgeVersions(db, entry.id)).toHaveLength(1);
    });
  });
});

describe("查詢與錯誤", () => {
  test("可以用 knowledgeId、layer 與 project 找到項目", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createDecision(db, home);
      const found = findKnowledgeEntry(db, "k-store-lifecycle", "project", "test-project");
      expect(found?.id).toBe(entry.id);
      expect(findKnowledgeEntry(db, "k-store-lifecycle", "global", null)).toBeNull();
      expect(getKnowledgeEntry(db, entry.id)?.id).toBe(entry.id);
      expect(getKnowledgeEntry(db, 9999)).toBeNull();
    });
  });

  test("不存在的 entry 與 version 回清楚的錯誤", async () => {
    await withTestDatabase(async ({ db, home }) => {
      insertTestProject(db);
      const entry = createDecision(db, home);

      expect(() => readKnowledgeEntry(db, 9999, storeOptions(home))).toThrow(/知識項目/);
      expect(() => readKnowledgeVersion(db, entry.id, 99, storeOptions(home))).toThrow(/版本/);
      expect(() =>
        updateKnowledgeEntry(db, 9999, { content: "x", actor: "build" }, storeOptions(home)),
      ).toThrow(/知識項目/);
    });
  });
});
