import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEntry, KnowledgeVersion } from "../../../src/domain/knowledge.ts";
import { createKnowledgeEntry, findKnowledgeEntry, readKnowledgeVersion } from "../../../src/knowledge/store.ts";
import { registerProject } from "../../../src/project/registry.ts";
import { resolveProject } from "../../../src/project/resolve.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgePromote } from "../../../src/tools/knowledge/promote.ts";
import { tool as knowledgeRetire } from "../../../src/tools/knowledge/retire.ts";
import { tool as knowledgeWrite } from "../../../src/tools/knowledge/write.ts";
import { createGitRepo } from "../../helpers/git.ts";
import {
  callTool,
  dataOf,
  failureOf,
  withDatabase,
  withKnowledgeWriteFixture,
} from "./helpers.ts";

const FAKE_AWS_KEY = `AKIA${"TESTTESTTESTTEST"}`;

interface WriteData {
  entry: KnowledgeEntry;
  version: KnowledgeVersion;
  artifactPath: string;
}

interface PromoteData {
  global: WriteData;
  project: KnowledgeEntry;
  archived: Array<{ from: string; to: string }>;
  idempotentReplay: boolean;
}

describe("knowledge_promote", () => {
  test("升級專案技能後建立全域版本，原專案項目退役並指向全域", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "---\nname: promote-skill\ndescription: 升級技能\n---\n\n# Promote\n";
      const projectWrite = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "promote-skill",
            title: "升級技能",
            description: "升級技能",
            content,
            files: [{ path: "references/guide.md", content: "# Guide\n" }],
            sourceSignalIds: ["signal-promote"],
          },
          fixture,
        ),
      );
      const projectRoot = join(fixture.repo, ".agents", "skills", "promote-skill");
      expect(existsSync(join(projectRoot, "SKILL.md"))).toBe(true);

      const promoted = dataOf<PromoteData>(
        await callTool(
          knowledgePromote,
          { knowledgeId: "promote-skill", reason: "跨專案共用" },
          fixture,
        ),
      );

      expect(promoted.idempotentReplay).toBe(false);
      expect(promoted.global.entry.layer).toBe("global");
      expect(promoted.global.entry.projectId).toBeNull();
      expect(promoted.global.entry.status).toBe("active");
      expect(promoted.global.entry.knowledgeId).toBe("promote-skill");
      expect(promoted.global.version.reason).toBe("跨專案共用");
      expect(promoted.project.status).toBe("retired");
      expect(promoted.project.layer).toBe("project");
      expect(promoted.project.tags).toContain("promoted-to:global:promote-skill");
      expect(promoted.global.entry.tags).toContain(
        `promoted-from:project:${fixture.project.projectId}/promote-skill`,
      );

      const globalRoot = join(fixture.root, "home", ".agents", "skills", "promote-skill");
      expect(promoted.global.artifactPath).toBe(globalRoot);
      expect(readFileSync(join(globalRoot, "SKILL.md"), "utf8")).toBe(content);
      expect(readFileSync(join(globalRoot, "references", "guide.md"), "utf8")).toBe("# Guide\n");

      expect(existsSync(projectRoot)).toBe(false);
      expect(promoted.archived).toHaveLength(1);
      expect(readFileSync(join(promoted.archived[0]!.to, "SKILL.md"), "utf8")).toBe(content);

      const history = withDatabase(fixture, (db) => ({
        projectEntry: findKnowledgeEntry(
          db,
          "promote-skill",
          "project",
          fixture.project.projectId,
        )!,
        globalEntry: findKnowledgeEntry(db, "promote-skill", "global", null)!,
        projectVersions: listKnowledgeVersions(db, projectWrite.entry.id),
        projectContent: readKnowledgeVersion(db, projectWrite.entry.id, 1, {
          env: fixture.env,
          recordUsage: false,
        }).content,
      }));
      expect(history.projectEntry.status).toBe("retired");
      expect(history.globalEntry.status).toBe("active");
      expect(history.projectVersions).toHaveLength(1);
      expect(history.projectContent).toBe(content);

      const replay = dataOf<PromoteData>(
        await callTool(knowledgePromote, { knowledgeId: "promote-skill" }, fixture),
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.global.entry.id).toBe(promoted.global.entry.id);
      const globalCount = withDatabase(
        fixture,
        (db) =>
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM knowledge_entries WHERE layer = 'global' AND knowledge_id = 'promote-skill'",
            )
            .get()?.count ?? 0,
      );
      expect(globalCount).toBe(1);
    });
  });

  test("升級專案記憶時建立全域記憶檔並封存專案檔", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "# 專案記憶\n\n升級後要保留。";
      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "promote-memory",
            title: "升級記憶",
            description: "記憶升級",
            content,
            sourceSignalIds: ["signal-memory"],
          },
          fixture,
        ),
      );
      const projectFile = join(
        fixture.home,
        "memory",
        "projects",
        fixture.project.projectId,
        "topics",
        "promote-memory.md",
      );
      expect(existsSync(projectFile)).toBe(true);

      const promoted = dataOf<PromoteData>(
        await callTool(knowledgePromote, { knowledgeId: "promote-memory" }, fixture),
      );

      expect(promoted.global.entry.layer).toBe("global");
      expect(promoted.global.entry.kind).toBe("memory");
      expect(promoted.global.entry.tags).toContain(
        `promoted-from:project:${fixture.project.projectId}/promote-memory`,
      );
      expect(promoted.project.status).toBe("retired");
      expect(promoted.project.tags).toContain("promoted-to:global:promote-memory");
      expect(promoted.global.version.sourceSignalIds).toEqual(["signal-memory"]);

      const globalFile = join(fixture.home, "memory", "topics", "promote-memory.md");
      expect(existsSync(globalFile)).toBe(true);
      const globalText = readFileSync(globalFile, "utf8");
      expect(globalText).toContain('title: "升級記憶"');
      expect(globalText).toContain(content);

      expect(existsSync(projectFile)).toBe(false);
      expect(promoted.archived.some((entry) => entry.from === projectFile)).toBe(true);
    });
  });

  test("全域已有同名項目時拒絕升級", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      withDatabase(fixture, (inner) => {
        registerProject(inner, fixture.project);
        createKnowledgeEntry(
          inner,
          {
            knowledgeId: "duplicate-topic",
            layer: "project",
            projectId: fixture.project.projectId,
            kind: "memory",
            type: "lesson",
            title: "專案版本",
            description: "",
            content: "# project\n",
            actor: "build",
          },
          { env: fixture.env },
        );
        createKnowledgeEntry(
          inner,
          {
            knowledgeId: "duplicate-topic",
            layer: "global",
            kind: "memory",
            type: "lesson",
            title: "全域版本",
            description: "",
            content: "# global\n",
            actor: "build",
          },
          { env: fixture.env },
        );
      });

      const conflict = failureOf(
        await callTool(knowledgePromote, { knowledgeId: "duplicate-topic" }, fixture),
      );
      expect(conflict.code).toBe("KNOWLEDGE_ALREADY_EXISTS");

      const statuses = withDatabase(fixture, (inner) => ({
        project: findKnowledgeEntry(
          inner,
          "duplicate-topic",
          "project",
          fixture.project.projectId,
        )?.status,
        global: findKnowledgeEntry(inner, "duplicate-topic", "global", null)?.status,
      }));
      expect(statuses).toEqual({ project: "active", global: "active" });
    });
  });

  test("expectedVersion 過期時拒絕升級，且不建立全域項目", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const written = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "stale-promote",
            title: "過期升級",
            content: "# v1\n",
          },
          fixture,
        ),
      );

      const stale = failureOf(
        await callTool(
          knowledgePromote,
          { knowledgeId: "stale-promote", expectedVersion: written.entry.version + 3 },
          fixture,
        ),
      );
      expect(stale.code).toBe("VERSION_CONFLICT");

      const entries = withDatabase(fixture, (db) => ({
        project: findKnowledgeEntry(
          db,
          "stale-promote",
          "project",
          fixture.project.projectId,
        ),
        global: findKnowledgeEntry(db, "stale-promote", "global", null),
      }));
      expect(entries.project?.status).toBe("active");
      expect(entries.global).toBeNull();
    });
  });

  test("其他專案有 active 同名技能時拒絕升級，退役後才允許", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const repoB = await createGitRepo(join(fixture.root, "repo-b"));
      const projectB = resolveProject({ explicitPath: repoB, env: fixture.env });
      const content = [
        "---",
        "name: collide-skill",
        "description: 跨專案同名",
        "---",
        "",
        "# Collide",
      ].join("\n");

      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "collide-skill",
            title: "跨專案同名",
            description: "跨專案同名",
            content,
            projectPath: repoB,
          },
          fixture,
        ),
      );
      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "collide-skill",
            title: "跨專案同名",
            description: "跨專案同名",
            content,
          },
          fixture,
        ),
      );

      const conflict = failureOf(
        await callTool(knowledgePromote, { knowledgeId: "collide-skill" }, fixture),
      );
      expect(conflict.code).toBe("KNOWLEDGE_LAYER_CONFLICT");
      expect(conflict.data.conflictingProjectId).toBe(projectB.projectId);

      const beforeRetire = withDatabase(fixture, (db) => ({
        global: findKnowledgeEntry(db, "collide-skill", "global", null),
        projectA: findKnowledgeEntry(
          db,
          "collide-skill",
          "project",
          fixture.project.projectId,
        )?.status,
      }));
      expect(beforeRetire.global).toBeNull();
      expect(beforeRetire.projectA).toBe("active");

      dataOf(
        await callTool(
          knowledgeRetire,
          { knowledgeId: "collide-skill", layer: "project", projectPath: repoB },
          fixture,
        ),
      );

      const promoted = dataOf<PromoteData>(
        await callTool(knowledgePromote, { knowledgeId: "collide-skill" }, fixture),
      );
      expect(promoted.global.entry.layer).toBe("global");
      expect(promoted.global.entry.status).toBe("active");
      expect(promoted.project.status).toBe("retired");
    });
  });

  test("全域版本已退役時不把專案項目當成已升級", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = [
        "---",
        "name: retired-global-skill",
        "description: 退役全域",
        "---",
        "",
        "# Retired global",
      ].join("\n");
      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "retired-global-skill",
            title: "退役全域",
            description: "退役全域",
            content,
          },
          fixture,
        ),
      );
      dataOf<PromoteData>(
        await callTool(
          knowledgePromote,
          { knowledgeId: "retired-global-skill" },
          fixture,
        ),
      );
      dataOf(
        await callTool(
          knowledgeRetire,
          { knowledgeId: "retired-global-skill", layer: "global" },
          fixture,
        ),
      );

      const conflict = failureOf(
        await callTool(
          knowledgePromote,
          { knowledgeId: "retired-global-skill" },
          fixture,
        ),
      );
      expect(conflict.code).toBe("KNOWLEDGE_GLOBAL_RETIRED");

      const state = withDatabase(fixture, (db) => ({
        global: findKnowledgeEntry(db, "retired-global-skill", "global", null),
        project: findKnowledgeEntry(
          db,
          "retired-global-skill",
          "project",
          fixture.project.projectId,
        ),
      }));
      expect(state.global?.status).toBe("retired");
      expect(state.project?.status).toBe("retired");
    });
  });

  test("升級前會掃描專案項目的 title 與 source", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      withDatabase(fixture, (db) => {
        registerProject(db, fixture.project);
        createKnowledgeEntry(
          db,
          {
            knowledgeId: "secret-promote",
            layer: "project",
            projectId: fixture.project.projectId,
            kind: "memory",
            type: "reference",
            title: `標題 ${FAKE_AWS_KEY}`,
            description: "",
            source: `manual ${FAKE_AWS_KEY}`,
            content: "# secret\n",
            actor: "build",
          },
          { env: fixture.env },
        );
      });

      const conflict = failureOf(
        await callTool(knowledgePromote, { knowledgeId: "secret-promote" }, fixture),
      );
      expect(conflict.code).toBe("KNOWLEDGE_CHECK_FAILED");
      expect(conflict.data.errors).toContainEqual(
        expect.objectContaining({ code: "SECRET_DETECTED", field: "title" }),
      );
      expect(conflict.data.errors).toContainEqual(
        expect.objectContaining({ code: "SECRET_DETECTED", field: "source" }),
      );

      const globalEntry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, "secret-promote", "global", null),
      );
      expect(globalEntry).toBeNull();
    });
  });

  test("沒有專案項目時回清楚的錯誤", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const missing = failureOf(
        await callTool(knowledgePromote, { knowledgeId: "never-written" }, fixture),
      );
      expect(missing.code).toBe("KNOWLEDGE_ENTRY_NOT_FOUND");
    });
  });
});
