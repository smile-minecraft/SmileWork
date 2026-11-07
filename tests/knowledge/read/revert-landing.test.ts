import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { findKnowledgeEntry } from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgeRead } from "../../../src/tools/knowledge/read.ts";
import { tool as knowledgeRevert } from "../../../src/tools/knowledge/revert.ts";
import {
  appendVersion,
  callTool,
  dataOf,
  failureOf,
  materializeEntry,
  readVersionContent,
  seedKnowledge,
  withDatabase,
  withKnowledgeFixture,
  type KnowledgeFixture,
} from "./helpers.ts";

interface RevertData {
  entry: { entryId: number; id: string; currentVersion: number };
  version: { version: number; sha256: string; bytes: number };
  restoredFrom: { version: number; sha256: string; bytes: number };
  byteIdentical: boolean;
  landing:
    | {
        synced: true;
        projectPath: string | null;
        artifactPath: string;
        createdRoot: boolean;
        files: Array<{ path: string; absolutePath: string; bytes: number }>;
      }
    | {
        synced: false;
        reason: "artifact-not-found" | "artifact-ambiguous";
        artifactPath: null;
        createdRoot: false;
        files: [];
        candidates: string[];
        matches?: string[];
      }
    | null;
}

interface ReadData {
  content: string;
  version: { version: number };
}

function memoryBody(document: string): string {
  const marker = "\n---\n\n";
  const start = document.indexOf(marker);
  if (start < 0) throw new Error("落地記憶檔缺少 frontmatter 結尾。");
  return document.slice(start + marker.length);
}

function syncedLanding(reverted: RevertData) {
  const landing = reverted.landing;
  if (landing === null || landing.synced !== true) {
    throw new Error("預期落地檔同步成功。");
  }
  return landing;
}

function memoryPath(fixture: KnowledgeFixture): string {
  return join(fixture.home, "memory", "topics", "landing-memory.md");
}

function skillRoot(fixture: KnowledgeFixture): string {
  return join(fixture.repo, ".agents", "skills", "landing-skill");
}

function createMemory(fixture: KnowledgeFixture, content: string) {
  const entry = seedKnowledge(fixture, {
    knowledgeId: "landing-memory",
    layer: "global",
    title: "落地記憶",
    description: "還原同步測試",
    content,
  });
  materializeEntry(fixture, entry, content);
  return entry;
}

function updateMemory(fixture: KnowledgeFixture, entryId: number, content: string) {
  const updated = appendVersion(fixture, entryId, content, { reason: "更新記憶" });
  materializeEntry(fixture, updated, content);
  return updated;
}

function createSkill(fixture: KnowledgeFixture, content: string, attachment: string) {
  const entry = seedKnowledge(fixture, {
    knowledgeId: "landing-skill",
    kind: "skill",
    type: "document",
    title: "落地技能",
    description: "還原同步測試",
    content,
  });
  materializeEntry(fixture, entry, content, {
    files: [{ path: "references/guide.md", content: attachment }],
  });
  return entry;
}

function updateSkill(
  fixture: KnowledgeFixture,
  entryId: number,
  content: string,
  attachment: string,
) {
  const updated = appendVersion(fixture, entryId, content, { reason: "更新技能" });
  materializeEntry(fixture, updated, content, {
    files: [{ path: "references/guide.md", content: attachment }],
  });
  return updated;
}

const memoryV1 = "# 第一版\n\n記住中文與 emoji 🚀\n";
const memoryV2 = "# 第二版\n\n這是後來的內容\n";

const skillV1 = "---\nname: landing-skill\ndescription: 還原同步測試\n---\n\n# 技能第一版\n";
const skillV2 = "---\nname: landing-skill\ndescription: 還原同步測試\n---\n\n# 技能第二版\n";

describe("knowledge_revert 同步落地檔", () => {
  test("記憶還原後，落地檔本文與資料庫新版本逐位元組相同", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = createMemory(fixture, memoryV1);
      const updated = updateMemory(fixture, entry.id, memoryV2);
      expect(updated.currentVersion).toBe(2);
      const path = memoryPath(fixture);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("第二版");

      const reverted = dataOf<RevertData>(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "landing-memory", layer: "global", version: 1, reason: "回到第一版" },
          fixture,
        ),
      );

      expect(reverted.entry.currentVersion).toBe(3);
      expect(reverted.version.version).toBe(3);
      expect(reverted.restoredFrom.version).toBe(1);
      expect(reverted.byteIdentical).toBe(true);
      expect(reverted.version.sha256).toBe(reverted.restoredFrom.sha256);
      const landing = syncedLanding(reverted);
      expect(landing.artifactPath).toBe(path);
      expect(landing.files.map((file) => file.path)).toEqual(["landing-memory.md"]);

      const document = readFileSync(path, "utf8");
      const body = memoryBody(document);
      expect(Buffer.from(body, "utf8").equals(Buffer.from(memoryV1, "utf8"))).toBe(true);
      expect(document).not.toContain("第二版");

      const versions = withDatabase(fixture, (db) =>
        listKnowledgeVersions(db, reverted.entry.entryId),
      );
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
      expect(versions[2]!.sha256).toBe(versions[0]!.sha256);
      expect(readVersionContent(fixture, reverted.entry.entryId, 3)).toBe(memoryV1);
      expect(readVersionContent(fixture, reverted.entry.entryId, 2)).toBe(memoryV2);

      const oldVersion = dataOf<ReadData>(
        await callTool(
          knowledgeRead,
          { knowledgeId: "landing-memory", layer: "global", version: 2 },
          fixture,
        ),
      );
      expect(oldVersion.content).toBe(memoryV2);
      expect(oldVersion.version.version).toBe(2);
    });
  });

  test("技能還原後，SKILL.md 與指定版本逐位元組相同，既有附件不動", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = createSkill(fixture, skillV1, "# Guide v1\n");
      const updated = updateSkill(fixture, entry.id, skillV2, "# Guide v2\n");
      expect(updated.currentVersion).toBe(2);
      const root = skillRoot(fixture);
      const skillPath = join(root, "SKILL.md");
      const attachmentPath = join(root, "references", "guide.md");
      expect(readFileSync(skillPath, "utf8")).toBe(skillV2);
      expect(readFileSync(attachmentPath, "utf8")).toBe("# Guide v2\n");

      const reverted = dataOf<RevertData>(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "landing-skill", version: 1, reason: "回到技能第一版" },
          fixture,
        ),
      );

      expect(reverted.byteIdentical).toBe(true);
      const landing = syncedLanding(reverted);
      expect(realpathSync(landing.artifactPath)).toBe(realpathSync(root));
      expect(landing.files.map((file) => file.path)).toEqual(["SKILL.md"]);
      const bytes = readFileSync(skillPath);
      expect(Buffer.compare(bytes, Buffer.from(skillV1, "utf8"))).toBe(0);
      expect(bytes.toString("utf8")).toBe(skillV1);
      expect(readFileSync(attachmentPath, "utf8")).toBe("# Guide v2\n");

      expect(readVersionContent(fixture, reverted.entry.entryId, 3)).toBe(skillV1);
      expect(readVersionContent(fixture, reverted.entry.entryId, 2)).toBe(skillV2);
    });
  });

  test("落地檔不存在時，還原會重建主要檔案", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = createMemory(fixture, memoryV1);
      updateMemory(fixture, entry.id, memoryV2);
      const path = memoryPath(fixture);
      rmSync(path, { force: true });
      expect(existsSync(path)).toBe(false);

      const reverted = dataOf<RevertData>(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "landing-memory", layer: "global", version: 1 },
          fixture,
        ),
      );
      expect(existsSync(path)).toBe(true);
      expect(
        Buffer.from(memoryBody(readFileSync(path, "utf8")), "utf8").equals(
          Buffer.from(memoryV1, "utf8"),
        ),
      ).toBe(true);
      expect(syncedLanding(reverted).artifactPath).toBe(path);
    });
  });

  test("技能資料夾不存在時，還原會重建 SKILL.md 與目錄", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = createSkill(fixture, skillV1, "# Guide v1\n");
      updateSkill(fixture, entry.id, skillV2, "# Guide v2\n");
      const root = skillRoot(fixture);
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);

      const reverted = dataOf<RevertData>(
        await callTool(knowledgeRevert, { knowledgeId: "landing-skill", version: 1 }, fixture),
      );
      const skillPath = join(root, "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
      const landing = syncedLanding(reverted);
      expect(landing.createdRoot).toBe(true);
      expect(readFileSync(skillPath, "utf8")).toBe(skillV1);
    });
  });

  test("expectedVersion 過期時不建立版本，也不改落地檔", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = createMemory(fixture, memoryV1);
      updateMemory(fixture, entry.id, memoryV2);
      const path = memoryPath(fixture);
      const before = readFileSync(path);
      expect(before.toString("utf8")).toContain("第二版");

      const failure = failureOf(
        await callTool(
          knowledgeRevert,
          {
            knowledgeId: "landing-memory",
            layer: "global",
            version: 1,
            expectedVersion: 1,
          },
          fixture,
        ),
      );
      expect(failure.code).toBe("VERSION_CONFLICT");
      expect(Buffer.compare(readFileSync(path), before)).toBe(0);
      expect(readFileSync(path, "utf8")).toContain("第二版");

      const versions = withDatabase(fixture, (db) =>
        listKnowledgeVersions(db, entry.id),
      );
      expect(versions.map((version) => version.version)).toEqual([1, 2]);
    });
  });

  test("落地檔寫入失敗時回滾資料庫，不留下新版本", async () => {
    await withKnowledgeFixture(async (fixture) => {
      const entry = createMemory(fixture, memoryV1);
      updateMemory(fixture, entry.id, memoryV2);
      const path = memoryPath(fixture);
      rmSync(path, { force: true });
      mkdirSync(path);
      writeFileSync(join(path, "blocks-rename.txt"), "x");

      const failure = failureOf(
        await callTool(
          knowledgeRevert,
          { knowledgeId: "landing-memory", layer: "global", version: 1 },
          fixture,
        ),
      );
      expect(failure.code).toBe("INTERNAL_ERROR");

      const { entry: found, versions } = withDatabase(fixture, (db) => ({
        entry: findKnowledgeEntry(db, "landing-memory", "global", null)!,
        versions: listKnowledgeVersions(db, entry.id),
      }));
      expect(found.currentVersion).toBe(2);
      expect(versions.map((version) => version.version)).toEqual([1, 2]);
      expect(readVersionContent(fixture, entry.id, 2)).toBe(memoryV2);
      expect(
        readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    });
  });
});
