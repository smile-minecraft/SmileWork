import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEntry, KnowledgeVersion } from "../../../src/domain/knowledge.ts";
import { normalizeRelativeFilePath } from "../../../src/knowledge/materialize/paths.ts";
import { findKnowledgeEntry } from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { SmileworkError } from "../../../src/shared/errors.ts";
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

const INVALID_PATHS = [
  "references/",
  "SKILL.md/",
  "./",
  "",
  ".",
  "..",
  "references/../escape.md",
  "references/.",
  "references\\guide.md",
];

function skillContent(name: string, version = "# v1"): string {
  return [
    "---",
    `name: ${name}`,
    "description: 路徑驗證技能",
    "---",
    "",
    version,
  ].join("\n");
}

function countRows(
  fixture: Parameters<typeof withDatabase>[0],
  table: string,
): number {
  return withDatabase(
    fixture,
    (db) =>
      db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0,
  );
}

describe("附檔路徑正規化", () => {
  test("拒絕結尾斜線、空字串、點路徑、反斜線與逃逸", () => {
    for (const path of INVALID_PATHS) {
      expect(() => normalizeRelativeFilePath(path)).toThrow();
    }
    expect(normalizeRelativeFilePath("references/guide.md")).toBe("references/guide.md");
    expect(normalizeRelativeFilePath("assets//image.png")).toBe("assets/image.png");
  });

  test("錯誤資料會帶入呼叫端指定的欄位", () => {
    try {
      normalizeRelativeFilePath("references/", "files[2].path");
      throw new Error("應該要拒絕結尾斜線");
    } catch (error) {
      expect(error).toBeInstanceOf(SmileworkError);
      expect((error as SmileworkError).data).toMatchObject({
        field: "files[2].path",
        path: "references/",
      });
    }
  });
});

describe("建立時的路徑驗證", () => {
  test("技能帶非法附檔路徑時回 VALIDATION_ERROR，且不留下資料夾或版本", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      for (const [index, path] of INVALID_PATHS.entries()) {
        const knowledgeId = `path-create-${index}`;
        const failure = failureOf(
          await callTool(
            knowledgeWrite,
            {
              kind: "skill",
              layer: "project",
              knowledgeId,
              content: skillContent(knowledgeId),
              files: [{ path, content: "x" }],
            },
            fixture,
          ),
        );
        expect(failure.code).toBe("VALIDATION_ERROR");
        expect(failure.data.field).toBe("files[0].path");
        expect(
          existsSync(join(fixture.repo, ".agents", "skills", knowledgeId)),
        ).toBe(false);
      }

      expect(countRows(fixture, "knowledge_entries")).toBe(0);
      expect(countRows(fixture, "knowledge_versions")).toBe(0);
    });
  });

  test("第二個附檔路徑錯誤時指出 files[1].path", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "path-create-second";
      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId,
            content: skillContent(knowledgeId),
            files: [
              { path: "references/ok.md", content: "ok" },
              { path: "references/", content: "bad" },
            ],
          },
          fixture,
        ),
      );
      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[1].path");
      expect(existsSync(join(fixture.repo, ".agents", "skills", knowledgeId))).toBe(false);
      expect(countRows(fixture, "knowledge_entries")).toBe(0);
    });
  });

  test("記憶帶空附檔路徑時回 VALIDATION_ERROR，且不建立檔案", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "path-memory-create",
            title: "路徑驗證",
            content: "# 安全內容",
            files: [{ path: "", content: "x" }],
          },
          fixture,
        ),
      );
      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[0].path");
      expect(
        existsSync(join(fixture.home, "memory", "topics", "path-memory-create.md")),
      ).toBe(false);
      expect(countRows(fixture, "knowledge_entries")).toBe(0);
    });
  });
});

describe("更新時的路徑驗證", () => {
  test("技能更新帶非法附檔路徑時，SKILL.md、附檔與 DB 版本都不變", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "path-update-skill";
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

      for (const path of INVALID_PATHS) {
        const failure = failureOf(
          await callTool(
            knowledgeWrite,
            {
              kind: "skill",
              layer: "project",
              knowledgeId,
              content: contentV2,
              files: [{ path, content: "x" }],
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
          const entry = findKnowledgeEntry(db, knowledgeId, "project", fixture.project.projectId)!;
          return {
            currentVersion: entry.currentVersion,
            versions: listKnowledgeVersions(db, entry.id).length,
          };
        });
        expect(state.currentVersion).toBe(1);
        expect(state.versions).toBe(1);
      }
    });
  });

  test("記憶更新帶空附檔路徑時，記憶檔與 DB 版本都不變", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "path-update-memory";
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId,
            title: "路徑驗證",
            content: "# v1",
          },
          fixture,
        ),
      );
      const filePath = join(fixture.home, "memory", "topics", `${knowledgeId}.md`);
      const contentV1 = readFileSync(filePath, "utf8");

      const failure = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId,
            content: "# v2",
            files: [{ path: "", content: "x" }],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );
      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.data.field).toBe("files[0].path");
      expect(readFileSync(filePath, "utf8")).toBe(contentV1);

      const state = withDatabase(fixture, (db) => {
        const entry = findKnowledgeEntry(db, knowledgeId, "global", null)!;
        return {
          currentVersion: entry.currentVersion,
          versions: listKnowledgeVersions(db, entry.id).length,
        };
      });
      expect(state.currentVersion).toBe(1);
      expect(state.versions).toBe(1);
    });
  });

  test("大小寫不同的 skill.md 不會覆寫 SKILL.md", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const knowledgeId = "path-reserved-skill";
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

      for (const reserved of ["SKILL.md", "skill.md", "SkIlL.Md"]) {
        const failure = failureOf(
          await callTool(
            knowledgeWrite,
            {
              kind: "skill",
              layer: "project",
              knowledgeId,
              content: contentV2,
              files: [{ path: reserved, content: "覆寫內容" }],
              expectedVersion: first.entry.version,
            },
            fixture,
          ),
        );
        expect(failure.code).toBe("VALIDATION_ERROR");
        expect(failure.data.field).toBe("files[0].path");
        expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV1);
      }

      const versions = withDatabase(fixture, (db) => {
        const entry = findKnowledgeEntry(
          db,
          knowledgeId,
          "project",
          fixture.project.projectId,
        )!;
        return listKnowledgeVersions(db, entry.id).length;
      });
      expect(versions).toBe(1);

      const createConflict = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "path-reserved-create",
            content: skillContent("path-reserved-create"),
            files: [{ path: "skill.md", content: "覆寫內容" }],
          },
          fixture,
        ),
      );
      expect(createConflict.code).toBe("VALIDATION_ERROR");
      expect(createConflict.data.field).toBe("files[0].path");
      expect(
        existsSync(join(fixture.repo, ".agents", "skills", "path-reserved-create")),
      ).toBe(false);
    });
  });
});
