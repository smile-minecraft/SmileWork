import { describe, expect, test } from "bun:test";
import {
  CHECK_CODES,
  checkKnowledgeWrite,
  checkSkillLayerConflict,
} from "../../../src/knowledge/checks/index.ts";
import { withTestDatabase } from "../../helpers/db.ts";
import { insertKnowledgeEntry } from "./helpers.ts";

const DESCRIPTION = "共用技能。";
const FILES = [
  {
    path: "SKILL.md",
    content: `---\nname: shared-skill\ndescription: ${DESCRIPTION}\n---\n`,
  },
];

function skillWrite(overrides: Record<string, unknown> = {}) {
  return {
    kind: "skill" as const,
    name: "shared-skill",
    directoryName: "shared-skill",
    description: DESCRIPTION,
    layer: "project" as const,
    projectId: "test-project",
    files: FILES,
    ...overrides,
  };
}

describe("跨層同名", () => {
  test("專案層寫入遇到全域同名技能被拒絕", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "shared-skill",
        title: "shared-skill",
        layer: "global",
      });

      const result = checkKnowledgeWrite(skillWrite(), { db });

      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: CHECK_CODES.skillNameConflict, field: "name" }),
      );
    });
  });

  test("全域寫入預設比對所有專案的同名技能", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "k-shared-skill",
        title: "shared-skill",
        layer: "project",
        projectId: "other-project",
      });

      const result = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "global",
        projectId: "test-project",
      });

      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatchObject({
        code: CHECK_CODES.skillNameConflict,
        field: "name",
      });
    });
  });

  test("全域寫入透過 checkKnowledgeWrite 也會比對其他專案", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "k-shared-skill",
        title: "shared-skill",
        layer: "project",
        projectId: "other-project",
      });

      const result = checkKnowledgeWrite(skillWrite({ layer: "global" }), { db });

      expect(result.ok).toBe(false);
      expect(result.errors.some((issue) => issue.code === CHECK_CODES.skillNameConflict)).toBe(
        true,
      );
    });
  });

  test("只有明確開啟 scopeToProject 才縮限到指定專案", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "k-shared-skill",
        title: "shared-skill",
        layer: "project",
        projectId: "other-project",
      });

      const scoped = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "global",
        projectId: "test-project",
        scopeToProject: true,
      });
      const unscoped = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "global",
        projectId: "test-project",
      });

      expect(scoped.ok).toBe(true);
      expect(unscoped.ok).toBe(false);
    });
  });

  test("knowledge_id 相同但 title 不同也會被視為同名", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "shared-skill",
        title: "共用技能",
        layer: "global",
      });

      const result = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "project",
        projectId: "test-project",
      });

      expect(result.ok).toBe(false);
    });
  });

  test("同層同名不在這個檢查的範圍", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "shared-skill",
        title: "shared-skill",
        layer: "project",
        projectId: "test-project",
      });

      const result = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "project",
        projectId: "test-project",
      });

      expect(result.ok).toBe(true);
    });
  });

  test("已退役的項目不算同名", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "shared-skill",
        title: "shared-skill",
        layer: "global",
        status: "retired",
      });

      const result = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "project",
        projectId: "test-project",
      });

      expect(result.ok).toBe(true);
    });
  });

  test("記憶項目的同名不影響技能檢查", async () => {
    await withTestDatabase(({ db }) => {
      insertKnowledgeEntry(db, {
        knowledgeId: "shared-skill",
        title: "shared-skill",
        layer: "global",
        kind: "memory",
      });

      const result = checkSkillLayerConflict({
        db,
        name: "shared-skill",
        layer: "project",
        projectId: "test-project",
      });

      expect(result.ok).toBe(true);
    });
  });
});
