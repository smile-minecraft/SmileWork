import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgeRevert } from "../../../src/tools/knowledge/revert.ts";
import { createGitWorktree } from "../../helpers/git.ts";
import {
  appendVersion,
  callTool,
  dataOf,
  materializeEntry,
  readVersionContent,
  seedKnowledge,
  withDatabase,
  withKnowledgeFixture,
  type KnowledgeFixture,
} from "./helpers.ts";

interface RevertData {
  entry: { entryId: number; id: string; currentVersion: number };
  version: { version: number; sha256: string };
  restoredFrom: { version: number; sha256: string };
  landing:
    | {
        synced: true;
        projectPath: string | null;
        artifactPath: string;
        createdRoot: boolean;
      }
    | {
        synced: false;
        reason: "artifact-not-found" | "artifact-ambiguous";
        candidates: string[];
        matches?: string[];
      }
    | null;
}

const skillV1 = "---\nname: landing-skill\ndescription: 跨 worktree 測試\n---\n\n# 第一版\n";
const skillV2 = "---\nname: landing-skill\ndescription: 跨 worktree 測試\n---\n\n# 第二版\n";

function skillArtifact(worktree: string): string {
  return join(worktree, ".agents", "skills", "landing-skill");
}

function syncedLanding(reverted: RevertData) {
  const landing = reverted.landing;
  if (landing === null || landing.synced !== true) {
    throw new Error("預期落地檔同步成功。");
  }
  return landing;
}

function unsyncedLanding(reverted: RevertData) {
  const landing = reverted.landing;
  if (landing === null || landing.synced !== false) {
    throw new Error("預期 landing 未同步。");
  }
  return landing;
}

async function addLinkedWorktree(fixture: KnowledgeFixture): Promise<string> {
  return createGitWorktree(fixture.repo, join(fixture.root, "linked"), "feature");
}

function createSkillIn(fixture: KnowledgeFixture, worktree: string) {
  const entry = seedKnowledge(fixture, {
    knowledgeId: "landing-skill",
    kind: "skill",
    type: "document",
    title: "跨 worktree 技能",
    description: "還原時要找到正確的 worktree",
    content: skillV1,
  });
  const files = [{ path: "references/guide.md", content: "# Guide v1\n" }];
  materializeEntry(fixture, entry, skillV1, { projectPath: worktree, files });
  const updated = appendVersion(fixture, entry.id, skillV2, { reason: "第二版" });
  materializeEntry(fixture, updated, skillV2, { projectPath: worktree, files });
  return entry;
}

describe("knowledge_revert 跨 worktree 定位", () => {
  test("linked worktree 建立的技能，revert 更新 linked，不寫主 checkout", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const linked = await addLinkedWorktree(fixture);
      const entry = createSkillIn(fixture, linked);
      expect(readFileSync(join(skillArtifact(linked), "SKILL.md"), "utf8")).toBe(skillV2);
      expect(existsSync(skillArtifact(fixture.repo))).toBe(false);

      const reverted = dataOf<RevertData>(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "landing-skill", projectPath: linked, version: 1 },
          fixture,
        ),
      );

      expect(reverted.entry.currentVersion).toBe(3);
      const landing = syncedLanding(reverted);
      expect(realpathSync(landing.artifactPath)).toBe(realpathSync(skillArtifact(linked)));
      expect(readFileSync(join(skillArtifact(linked), "SKILL.md"), "utf8")).toBe(skillV1);
      expect(existsSync(skillArtifact(fixture.repo))).toBe(false);
      expect(readVersionContent(fixture, entry.id, 3)).toBe(skillV1);
      expect(readVersionContent(fixture, entry.id, 2)).toBe(skillV2);
    });
  });

  test("主 checkout 建立的技能，從 linked revert 會更新主 checkout，linked 不被寫入", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const linked = await addLinkedWorktree(fixture);
      const entry = createSkillIn(fixture, fixture.repo);
      expect(readFileSync(join(skillArtifact(fixture.repo), "SKILL.md"), "utf8")).toBe(skillV2);
      expect(existsSync(skillArtifact(linked))).toBe(false);

      const reverted = dataOf<RevertData>(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "landing-skill", projectPath: linked, version: 1 },
          fixture,
        ),
      );

      const landing = syncedLanding(reverted);
      expect(realpathSync(landing.artifactPath)).toBe(
        realpathSync(skillArtifact(fixture.repo)),
      );
      expect(readFileSync(join(skillArtifact(fixture.repo), "SKILL.md"), "utf8")).toBe(skillV1);
      expect(existsSync(skillArtifact(linked))).toBe(false);
      expect(readVersionContent(fixture, entry.id, 3)).toBe(skillV1);
    });
  });

  test("多個 worktree 都找不到 artifact 時只還原版本並標示未同步", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const linked = await addLinkedWorktree(fixture);
      const entry = createSkillIn(fixture, fixture.repo);
      rmSync(skillArtifact(fixture.repo), { recursive: true, force: true });
      expect(existsSync(skillArtifact(fixture.repo))).toBe(false);

      const result = await callTool(
        knowledgeRevert,
        { knowledgeId: "landing-skill", projectPath: linked, version: 1 },
        fixture,
      );
      const reverted = dataOf<RevertData>(result);

      expect(result.ok && result.summary).toContain("只還原版本");
      expect(reverted.entry.currentVersion).toBe(3);
      const landing = unsyncedLanding(reverted);
      expect(landing.reason).toBe("artifact-not-found");
      expect(landing.candidates.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(skillArtifact(fixture.repo))).toBe(false);
      expect(existsSync(skillArtifact(linked))).toBe(false);

      const versions = withDatabase(fixture, (db) => listKnowledgeVersions(db, entry.id));
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
      expect(readVersionContent(fixture, entry.id, 3)).toBe(skillV1);
    });
  });
});
