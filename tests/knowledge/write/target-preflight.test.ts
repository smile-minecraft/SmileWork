import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEntry, KnowledgeVersion } from "../../../src/domain/knowledge.ts";
import { findKnowledgeEntry } from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgeWrite } from "../../../src/tools/knowledge/write.ts";
import {
  callTool,
  dataOf,
  failureOf,
  withDatabase,
  withKnowledgeWriteFixture,
} from "./helpers.ts";

interface WriteData {
  entry: KnowledgeEntry;
  version: KnowledgeVersion;
}

function skillContent(name: string, body = "# v1"): string {
  return [
    "---",
    `name: ${name}`,
    "description: 目標預檢技能",
    "---",
    "",
    body,
  ].join("\n");
}

describe("附檔目標預檢", () => {
  test("技能更新時目標與既有目錄同名，主檔與附檔都不變", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "target-skill-dir";
      const contentV1 = skillContent(knowledgeId, "# v1");
      const contentV2 = skillContent(knowledgeId, "# v2");
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV1,
            files: [{ path: "references/keep.md", content: "keep" }],
          },
          fixture,
        ),
      );
      const root = join(fixture.repo, ".agents", "skills", knowledgeId);

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV2,
            files: [{ path: "references", content: "x" }],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[0].path");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV1);
      expect(readFileSync(join(root, "references", "keep.md"), "utf8")).toBe("keep");
      const state = withDatabase(fixture, (db) => {
        const entry = findKnowledgeEntry(
          db,
          knowledgeId,
          "project",
          fixture.project.projectId,
        )!;
        return {
          currentVersion: entry.currentVersion,
          versions: listKnowledgeVersions(db, entry.id).length,
        };
      });
      expect(state).toEqual({ currentVersion: 1, versions: 1 });
    });
  });

  test("記憶更新時目標與既有目錄同名，主檔與附檔都不變", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "target-memory-dir";
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId,
            title: "目標預檢",
            content: "# v1",
            files: [{ path: "notes/keep.md", content: "keep" }],
          },
          fixture,
        ),
      );
      const topicPath = join(fixture.home, "memory", "topics", `${knowledgeId}.md`);
      const contentV1 = readFileSync(topicPath, "utf8");
      const notesPath = join(
        fixture.home,
        "memory",
        "files",
        knowledgeId,
        "notes",
        "keep.md",
      );

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId,
            content: "# v2",
            files: [{ path: "notes", content: "x" }],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[0].path");
      expect(readFileSync(topicPath, "utf8")).toBe(contentV1);
      expect(readFileSync(notesPath, "utf8")).toBe("keep");
      const state = withDatabase(fixture, (db) => {
        const entry = findKnowledgeEntry(db, knowledgeId, "global", null)!;
        return {
          currentVersion: entry.currentVersion,
          versions: listKnowledgeVersions(db, entry.id).length,
        };
      });
      expect(state).toEqual({ currentVersion: 1, versions: 1 });
    });
  });

  test("父層是既有檔案時拒絕，主檔不變", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "target-parent-file";
      const contentV1 = skillContent(knowledgeId, "# v1");
      const contentV2 = skillContent(knowledgeId, "# v2");
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV1,
            files: [{ path: "references", content: "file" }],
          },
          fixture,
        ),
      );
      const root = join(fixture.repo, ".agents", "skills", knowledgeId);

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV2,
            files: [{ path: "references/guide.md", content: "guide" }],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[0].path");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV1);
      expect(readFileSync(join(root, "references"), "utf8")).toBe("file");
      const entry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, knowledgeId, "project", fixture.project.projectId),
      );
      expect(entry?.currentVersion).toBe(1);
    });
  });

  test("第二個附檔預檢失敗時，主檔與第一個附檔都不寫入", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "target-second-fails";
      const contentV1 = skillContent(knowledgeId, "# v1");
      const contentV2 = skillContent(knowledgeId, "# v2");
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV1,
            files: [{ path: "blocker", content: "file" }],
          },
          fixture,
        ),
      );
      const root = join(fixture.repo, ".agents", "skills", knowledgeId);

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV2,
            files: [
              { path: "first.md", content: "first" },
              { path: "blocker/child.md", content: "child" },
            ],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[1].path");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV1);
      expect(existsSync(join(root, "first.md"))).toBe(false);
      expect(readFileSync(join(root, "blocker"), "utf8")).toBe("file");
      const entry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, knowledgeId, "project", fixture.project.projectId),
      );
      expect(entry?.currentVersion).toBe(1);
    });
  });

  test("同一批 files 同時把路徑當檔案與目錄時拒絕", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "target-prefix-conflict";
      const contentV1 = skillContent(knowledgeId, "# v1");
      const contentV2 = skillContent(knowledgeId, "# v2");
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV1,
          },
          fixture,
        ),
      );
      const root = join(fixture.repo, ".agents", "skills", knowledgeId);

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: contentV2,
            files: [
              { path: "bundle", content: "file" },
              { path: "bundle/child.md", content: "child" },
            ],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[0].path");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV1);
      const entry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, knowledgeId, "project", fixture.project.projectId),
      );
      expect(entry?.currentVersion).toBe(1);
    });
  });

  test("建立技能時技能資料夾已存在，不建立部分檔案", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "target-create-dir";
      const root = join(fixture.repo, ".agents", "skills", knowledgeId);
      mkdirSync(join(root, "references"), { recursive: true });
      writeFileSync(join(root, "references", "keep.md"), "keep", "utf8");

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: skillContent(knowledgeId, "# new"),
            files: [{ path: "new.md", content: "new" }],
          },
          fixture,
        ),
      );

      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(existsSync(join(root, "new.md"))).toBe(false);
      expect(readFileSync(join(root, "references", "keep.md"), "utf8")).toBe("keep");
      const entry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, knowledgeId, "project", fixture.project.projectId),
      );
      expect(entry).toBeNull();
    });
  });
});
