import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgeRevert } from "../../../src/tools/knowledge/revert.ts";
import {
  appendVersion,
  callTool,
  dataOf,
  failureOf,
  readVersionContent,
  seedKnowledge,
  withDatabase,
  withKnowledgeFixture,
} from "./helpers.ts";

interface RevertVersionView {
  version: number;
  sha256: string;
  bytes: number;
  actor: string;
  actorModel: string | null;
  reason: string | null;
  sourceSignalIds: string[];
  createdAt: string;
}

interface RevertData {
  entry: {
    id: string;
    entryId: number;
    currentVersion: number;
  };
  restoredFrom: { version: number; sha256: string; bytes: number };
  version: RevertVersionView;
  byteIdentical: boolean;
}

const originalContent = "# 第一版\n\n含中文與 emoji 🚀 的原始內容\n";

describe("knowledge_revert", () => {
  test("還原到舊版會建立新版本，內容與來源版本逐位元組相同", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-revert",
        content: originalContent,
        reason: "初始版本",
      });
      appendVersion(fixture, entry.id, "# 第二版\n\n完全不同的內容\n", { reason: "第二版" });
      appendVersion(fixture, entry.id, "# 第三版\n\n又改了一次\n", { reason: "第三版" });

      const result = dataOf<RevertData>(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "k-revert", version: 1, reason: "回到第一版" },
          fixture,
        ),
      );

      expect(result.entry.id).toBe("k-revert");
      expect(result.entry.currentVersion).toBe(4);
      expect(result.version.version).toBe(4);
      expect(result.version.actor).toBe("build");
      expect(result.version.actorModel).toBe("test-model");
      expect(result.version.reason).toBe("回到第一版");
      expect(result.restoredFrom.version).toBe(1);
      expect(result.restoredFrom.sha256).toBe(result.version.sha256);
      expect(result.restoredFrom.bytes).toBe(result.version.bytes);
      expect(result.byteIdentical).toBe(true);

      expect(readVersionContent(fixture, entry.id, 4)).toBe(originalContent);
      expect(readVersionContent(fixture, entry.id, 2)).toBe("# 第二版\n\n完全不同的內容\n");
      expect(readVersionContent(fixture, entry.id, 3)).toBe("# 第三版\n\n又改了一次\n");

      const versions = withDatabase(fixture, (db) => listKnowledgeVersions(db, entry.id));
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3, 4]);
      const source = versions.find((version) => version.version === 1)!;
      const restored = versions.find((version) => version.version === 4)!;
      const sourceBytes = readFileSync(join(fixture.home, "knowledge-store", source.snapshotPath));
      const restoredBytes = readFileSync(
        join(fixture.home, "knowledge-store", restored.snapshotPath),
      );
      expect(Buffer.compare(sourceBytes, restoredBytes)).toBe(0);
    });
  });

  test("還原到目前版本也會建立內容相同的新版本", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-revert-current",
        content: "目前內容\n",
      });

      const result = dataOf<RevertData>(
        await callTool(knowledgeRevert, { knowledgeId: "k-revert-current", version: 1 }, fixture),
      );
      expect(result.entry.currentVersion).toBe(2);
      expect(result.version.version).toBe(2);
      expect(result.byteIdentical).toBe(true);
      expect(readVersionContent(fixture, entry.id, 2)).toBe("目前內容\n");
    });
  });

  test("expectedVersion 過期時回版本衝突，且不建立新版本", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = seedKnowledge(fixture, {
        knowledgeId: "k-revert-conflict",
        content: "第一版\n",
      });
      appendVersion(fixture, entry.id, "第二版\n");

      const failure = failureOf(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "k-revert-conflict", version: 1, expectedVersion: 1 },
          fixture,
        ),
      );
      expect(failure.code).toBe("VERSION_CONFLICT");

      const versions = withDatabase(fixture, (db) => listKnowledgeVersions(db, entry.id));
      expect(versions.map((version) => version.version)).toEqual([1, 2]);
    });
  });

  test("不存在的知識與版本回清楚的錯誤", async () => {
    await withKnowledgeFixture(async (fixture) => {
      seedKnowledge(fixture, { knowledgeId: "k-revert-missing", content: "內容" });

      expect(
        failureOf(
          await callTool(knowledgeRevert, { knowledgeId: "k-unknown", version: 1 }, fixture),
        ).code,
      ).toBe("KNOWLEDGE_ENTRY_NOT_FOUND");
      expect(
        failureOf(
          await callTool(
            knowledgeRevert,
            { knowledgeId: "k-revert-missing", version: 9 },
            fixture,
          ),
        ).code,
      ).toBe("KNOWLEDGE_VERSION_NOT_FOUND");
    });
  });
});
