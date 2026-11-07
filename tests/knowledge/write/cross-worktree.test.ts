import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEntry, KnowledgeVersion } from "../../../src/domain/knowledge.ts";
import { findKnowledgeEntry } from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgePromote } from "../../../src/tools/knowledge/promote.ts";
import { tool as knowledgeRetire } from "../../../src/tools/knowledge/retire.ts";
import { tool as knowledgeWrite } from "../../../src/tools/knowledge/write.ts";
import { createGitWorktree } from "../../helpers/git.ts";
import {
  callTool,
  dataOf,
  failureOf,
  withDatabase,
  withKnowledgeWriteFixture,
  type KnowledgeWriteFixture,
} from "./helpers.ts";

interface WriteData {
  entry: KnowledgeEntry;
  version: KnowledgeVersion;
  artifactPath: string;
}

interface PromoteData {
  global: WriteData;
  project: KnowledgeEntry;
  archived: Array<{ from: string; to: string }>;
}

function skillContent(name: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: 跨 worktree 技能",
    "---",
    "",
    body,
  ].join("\n");
}

async function writeSkill(
  fixture: KnowledgeWriteFixture,
  knowledgeId: string,
  projectPath: string | undefined,
  body = "# v1",
): Promise<WriteData> {
  return dataOf<WriteData>(
    await callTool(
      knowledgeWrite,
      {
        kind: "skill",
        layer: "project",
        knowledgeId,
        title: "跨 worktree 技能",
        description: "跨 worktree 技能",
        content: skillContent(knowledgeId, body),
        ...(projectPath === undefined ? {} : { projectPath }),
      },
      fixture,
    ),
  );
}

describe("知識工具跨 worktree", () => {
  test("主 checkout 寫入、linked worktree 升級時處理主 checkout 的實體檔", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked-promote"),
        "linked-promote",
      );
      await writeSkill(fixture, "cross-main", undefined);
      const mainRoot = join(fixture.repo, ".agents", "skills", "cross-main");
      expect(existsSync(join(mainRoot, "SKILL.md"))).toBe(true);
      const mainCanonical = realpathSync(mainRoot);

      const promoted = dataOf<PromoteData>(
        await callTool(
          knowledgePromote,
          { knowledgeId: "cross-main", projectPath: linked },
          fixture,
        ),
      );

      expect(promoted.global.entry.status).toBe("active");
      expect(promoted.project.status).toBe("retired");
      expect(existsSync(mainRoot)).toBe(false);
      expect(existsSync(join(linked, ".agents", "skills", "cross-main"))).toBe(false);
      expect(
        promoted.archived.some((entry) => entry.from === mainCanonical),
      ).toBe(true);
    });
  });

  test("linked worktree 寫入、主 checkout 升級時處理 linked 的實體檔", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked-source"),
        "linked-source",
      );
      await writeSkill(fixture, "cross-linked", linked);
      const linkedRoot = join(linked, ".agents", "skills", "cross-linked");
      expect(existsSync(join(linkedRoot, "SKILL.md"))).toBe(true);

      const promoted = dataOf<PromoteData>(
        await callTool(knowledgePromote, { knowledgeId: "cross-linked" }, fixture),
      );

      expect(promoted.global.entry.status).toBe("active");
      expect(existsSync(linkedRoot)).toBe(false);
      expect(existsSync(join(fixture.repo, ".agents", "skills", "cross-linked"))).toBe(false);
    });
  });

  test("主 checkout 寫入、linked worktree 更新時只更新主 checkout", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked-update"),
        "linked-update",
      );
      const first = await writeSkill(fixture, "cross-update", undefined);
      const mainRoot = join(fixture.repo, ".agents", "skills", "cross-update");

      const updated = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "cross-update",
            title: "跨 worktree 技能",
            description: "跨 worktree 技能",
            content: skillContent("cross-update", "# v2"),
            expectedVersion: first.entry.version,
            projectPath: linked,
          },
          fixture,
        ),
      );

      expect(updated.entry.currentVersion).toBe(2);
      expect(readFileSync(join(mainRoot, "SKILL.md"), "utf8")).toContain("# v2");
      expect(existsSync(join(linked, ".agents", "skills", "cross-update"))).toBe(false);
    });
  });

  test("主 checkout 寫入、linked worktree 退役時封存主 checkout 的資料夾", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked-retire"),
        "linked-retire",
      );
      await writeSkill(fixture, "cross-retire", undefined);
      const mainRoot = join(fixture.repo, ".agents", "skills", "cross-retire");
      const mainCanonical = realpathSync(mainRoot);

      const retired = dataOf<{
        entry: KnowledgeEntry;
        archived: Array<{ from: string; to: string }>;
      }>(
        await callTool(
          knowledgeRetire,
          { knowledgeId: "cross-retire", layer: "project", projectPath: linked },
          fixture,
        ),
      );

      expect(retired.entry.status).toBe("retired");
      expect(existsSync(mainRoot)).toBe(false);
      expect(existsSync(join(linked, ".agents", "skills", "cross-retire"))).toBe(false);
      expect(
        retired.archived.some((entry) => entry.from === mainCanonical),
      ).toBe(true);
      const versions = withDatabase(fixture, (db) =>
        listKnowledgeVersions(db, retired.entry.id),
      );
      expect(versions).toHaveLength(1);
    });
  });

  test("linked worktree 寫入、主 checkout 退役時封存 linked 的資料夾", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked-retire-source"),
        "linked-retire-source",
      );
      await writeSkill(fixture, "cross-retire-linked", linked);
      const linkedRoot = join(linked, ".agents", "skills", "cross-retire-linked");

      const retired = dataOf<{
        entry: KnowledgeEntry;
        archived: Array<{ from: string; to: string }>;
      }>(
        await callTool(
          knowledgeRetire,
          { knowledgeId: "cross-retire-linked", layer: "project" },
          fixture,
        ),
      );

      expect(retired.entry.status).toBe("retired");
      expect(existsSync(linkedRoot)).toBe(false);
      expect(existsSync(join(fixture.repo, ".agents", "skills", "cross-retire-linked"))).toBe(false);
    });
  });

  test("同名技能同時存在兩個 worktree 時 fail closed", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked-ambiguous"),
        "linked-ambiguous",
      );
      await writeSkill(fixture, "cross-ambiguous", undefined);
      const mainRoot = join(fixture.repo, ".agents", "skills", "cross-ambiguous");
      const linkedSkills = join(linked, ".agents", "skills");
      mkdirSync(linkedSkills, { recursive: true });
      cpSync(mainRoot, join(linkedSkills, "cross-ambiguous"), { recursive: true });

      const conflict = failureOf(
        await callTool(
          knowledgePromote,
          { knowledgeId: "cross-ambiguous", projectPath: linked },
          fixture,
        ),
      );
      expect(conflict.code).toBe("KNOWLEDGE_ARTIFACT_AMBIGUOUS");
      expect(conflict.data.worktrees).toHaveLength(2);
      expect(existsSync(mainRoot)).toBe(true);
      expect(existsSync(join(linkedSkills, "cross-ambiguous"))).toBe(true);
      const globalEntry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, "cross-ambiguous", "global", null),
      );
      expect(globalEntry).toBeNull();
    });
  });
});
