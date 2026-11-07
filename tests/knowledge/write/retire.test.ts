import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeEntry, KnowledgeVersion } from "../../../src/domain/knowledge.ts";
import { findKnowledgeEntry, readKnowledgeVersion } from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import { tool as knowledgeRetire } from "../../../src/tools/knowledge/retire.ts";
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
  artifactPath: string;
}

interface RetireData {
  entry: KnowledgeEntry;
  alreadyRetired: boolean;
  archived: Array<{ from: string; to: string }>;
  missing: string[];
}

describe("knowledge_retire", () => {
  test("退役後保留歷史，並把記憶檔案移到封存區", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "# 待退役的記憶\n\n這段內容要留下來。";
      const written = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "retire-topic",
            title: "退役測試",
            content,
          },
          fixture,
        ),
      );

      const livePath = join(fixture.home, "memory", "topics", "retire-topic.md");
      expect(existsSync(livePath)).toBe(true);

      const retired = dataOf<RetireData>(
        await callTool(
          knowledgeRetire,
          { knowledgeId: "retire-topic", layer: "global", reason: "整理舊記憶" },
          fixture,
        ),
      );

      expect(retired.alreadyRetired).toBe(false);
      expect(retired.entry.status).toBe("retired");
      expect(retired.entry.currentVersion).toBe(1);
      expect(retired.archived).toHaveLength(1);
      expect(existsSync(livePath)).toBe(false);

      const archivePath = retired.archived[0]!.to;
      expect(existsSync(archivePath)).toBe(true);
      const archivedText = readFileSync(archivePath, "utf8");
      expect(archivedText).toContain('title: "退役測試"');
      expect(archivedText).toContain(content);

      const history = withDatabase(fixture, (db) => {
        const entry = findKnowledgeEntry(db, "retire-topic", "global", null)!;
        return {
          versions: listKnowledgeVersions(db, entry.id),
          content: readKnowledgeVersion(db, entry.id, 1, {
            env: fixture.env,
            recordUsage: false,
          }).content,
          retireUsage: db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM usage_events WHERE knowledge_id = ? AND action = 'retire'",
            )
            .get("retire-topic")?.count,
        };
      });
      expect(history.versions).toHaveLength(1);
      expect(history.content).toBe(content);
      expect(history.retireUsage).toBe(1);

      const again = dataOf<RetireData>(
        await callTool(
          knowledgeRetire,
          { knowledgeId: "retire-topic", layer: "global" },
          fixture,
        ),
      );
      expect(again.alreadyRetired).toBe(true);
      expect(again.entry.version).toBe(retired.entry.version);
      expect(history.versions).toHaveLength(1);
    });
  });

  test("技能退役時把整個資料夾移到封存區，附檔一起保留", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "---\nname: retire-skill\ndescription: 退役技能\n---\n\n# Retire\n";
      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "retire-skill",
            title: "退役技能",
            description: "退役技能",
            content,
            files: [{ path: "references/note.md", content: "# Note\n" }],
          },
          fixture,
        ),
      );
      const skillRoot = join(fixture.repo, ".agents", "skills", "retire-skill");
      expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(true);

      const retired = dataOf<RetireData>(
        await callTool(knowledgeRetire, { knowledgeId: "retire-skill", layer: "project" }, fixture),
      );

      expect(retired.entry.status).toBe("retired");
      expect(existsSync(skillRoot)).toBe(false);
      expect(retired.archived).toHaveLength(1);
      expect(readFileSync(join(retired.archived[0]!.to, "SKILL.md"), "utf8")).toBe(content);
      expect(readFileSync(join(retired.archived[0]!.to, "references", "note.md"), "utf8")).toBe("# Note\n");

      const versions = withDatabase(fixture, (db) =>
        listKnowledgeVersions(db, retired.entry.id),
      );
      expect(versions).toHaveLength(1);
    });
  });

  test("找不到知識或版本過期時回清楚的錯誤", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const missing = failureOf(
        await callTool(knowledgeRetire, { knowledgeId: "absent", layer: "global" }, fixture),
      );
      expect(missing.code).toBe("KNOWLEDGE_ENTRY_NOT_FOUND");

      const written = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "retire-version",
            title: "版本測試",
            content: "# v1\n",
          },
          fixture,
        ),
      );
      const stale = failureOf(
        await callTool(
          knowledgeRetire,
          {
            knowledgeId: "retire-version",
            layer: "project",
            expectedVersion: written.entry.version + 10,
          },
          fixture,
        ),
      );
      expect(stale.code).toBe("VERSION_CONFLICT");
      const entry = withDatabase(fixture, (db) =>
        findKnowledgeEntry(db, "retire-version", "project", fixture.project.projectId),
      );
      expect(entry?.status).toBe("active");
    });
  });
});
