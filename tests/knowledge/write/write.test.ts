import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findKnowledgeEntry } from "../../../src/knowledge/store.ts";
import { listKnowledgeVersions } from "../../../src/knowledge/versions.ts";
import type { KnowledgeEntry, KnowledgeVersion } from "../../../src/domain/knowledge.ts";
import { tool as knowledgeWrite } from "../../../src/tools/knowledge/write.ts";
import { createGitWorktree } from "../../helpers/git.ts";
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
  files: Array<{ path: string; absolutePath: string }>;
  idempotentReplay: boolean;
}

function countRows(fixture: Parameters<typeof withDatabase>[0], table: string): number {
  return withDatabase(
    fixture,
    (db) => db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0,
  );
}

describe("knowledge_write 記憶", () => {
  test("寫入 global memory 會落地檔案並帶正確 frontmatter", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "# 內容\n\n記住這個決定。";
      const result = await callTool(
        knowledgeWrite,
        {
          kind: "memory",
          layer: "global",
          knowledgeId: "global-topic",
          title: "全域記憶",
          description: "跨專案使用的測試記憶",
          type: "lesson",
          pinned: true,
          tags: ["beta", "alpha"],
          content,
          sourceSignalIds: ["signal-1", "signal-2"],
          reason: "整理全域教訓",
        },
        fixture,
      );
      const data = dataOf<WriteData>(result);

      expect(data.entry.layer).toBe("global");
      expect(data.entry.projectId).toBeNull();
      expect(data.entry.kind).toBe("memory");
      expect(data.entry.type).toBe("lesson");
      expect(data.entry.pinned).toBe(true);
      expect(data.entry.status).toBe("active");
      expect(data.entry.currentVersion).toBe(1);
      expect(data.idempotentReplay).toBe(false);

      const filePath = join(fixture.home, "memory", "topics", "global-topic.md");
      expect(data.artifactPath).toBe(filePath);
      expect(existsSync(filePath)).toBe(true);

      const text = readFileSync(filePath, "utf8");
      expect(text.startsWith("---\n")).toBe(true);
      expect(text).toContain('title: "全域記憶"');
      expect(text).toContain('description: "跨專案使用的測試記憶"');
      expect(text).toContain('type: "lesson"');
      expect(text).toContain("pinned: true");
      expect(text).toContain('source: "manual"');
      expect(text).toMatch(/created: "\d{4}-\d{2}-\d{2}T/);
      expect(text).toMatch(/updated: "\d{4}-\d{2}-\d{2}T/);
      expect(text).toMatch(/verified_at: "\d{4}-\d{2}-\d{2}T/);
      expect(text).toContain(content);

      const version = withDatabase(fixture, (db) => listKnowledgeVersions(db, data.entry.id)[0]!);
      expect(version.sourceSignalIds).toEqual(["signal-1", "signal-2"]);
      expect(version.reason).toBe("整理全域教訓");
      expect(version.actor).toBe("build");
      expect(version.snapshotPath).toContain("sha256/");
    });
  });
});

describe("knowledge_write 技能", () => {
  test("專案技能與附檔落地到專案 .agents/skills", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = [
        "---",
        "name: demo-skill",
        'description: "示範技能"',
        "---",
        "",
        "# Demo",
        "",
        "按照步驟操作。",
      ].join("\n");
      const result = await callTool(
        knowledgeWrite,
        {
          kind: "skill",
          layer: "project",
          knowledgeId: "demo-skill",
          title: "示範技能",
          description: "示範技能",
          content,
          files: [{ path: "references/guide.md", content: "# Guide\n" }],
          reason: "建立示範技能",
        },
        fixture,
      );
      const data = dataOf<WriteData>(result);

      expect(data.entry.layer).toBe("project");
      expect(data.entry.projectId).toBe(fixture.project.projectId);
      expect(data.entry.kind).toBe("skill");
      expect(data.entry.type).toBe("document");

      const root = join(fixture.repo, ".agents", "skills", "demo-skill");
      expect(realpathSync(data.artifactPath)).toBe(realpathSync(root));
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(content);
      expect(readFileSync(join(root, "references", "guide.md"), "utf8")).toBe("# Guide\n");
      expect(data.files.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md"]);

      const stored = withDatabase(fixture, (db) =>
        db
          .query<{ snapshot_path: string }, [number]>(
            "SELECT snapshot_path FROM knowledge_versions WHERE entry_id = ? AND version = 1",
          )
          .get(data.entry.id),
      );
      expect(stored).not.toBeNull();
    });
  });

  test("linked worktree 的專案技能寫在目前 worktree，不是主 checkout", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const linked = await createGitWorktree(
        fixture.repo,
        join(fixture.root, "linked"),
        "linked-skills",
      );
      const content = "---\nname: linked-skill\ndescription: Worktree 技能\n---\n\n# Linked\n";
      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "linked-skill",
            title: "Worktree 技能",
            description: "Worktree 技能",
            content,
            projectPath: linked,
          },
          fixture,
        ),
      );

      expect(existsSync(join(linked, ".agents", "skills", "linked-skill", "SKILL.md"))).toBe(true);
      expect(existsSync(join(fixture.repo, ".agents", "skills", "linked-skill"))).toBe(false);
    });
  });

  test("更新技能時移除未列出的舊附檔，且不動技能資料夾外的檔案", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const contentV1 =
        "---\nname: prune-skill\ndescription: 修剪附檔\n---\n\n# v1\n";
      const contentV2 =
        "---\nname: prune-skill\ndescription: 修剪附檔\n---\n\n# v2\n";
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "prune-skill",
            title: "修剪附檔",
            description: "修剪附檔",
            content: contentV1,
            files: [
              { path: "references/old.md", content: "old" },
              { path: "references/nested/old.md", content: "nested old" },
              { path: "references/keep.md", content: "keep-v1" },
            ],
          },
          fixture,
        ),
      );
      const outside = join(fixture.repo, "outside.txt");
      writeFileSync(outside, "outside", "utf8");

      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "prune-skill",
            title: "修剪附檔",
            description: "修剪附檔",
            content: contentV2,
            files: [{ path: "references/keep.md", content: "keep-v2" }],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      const root = join(fixture.repo, ".agents", "skills", "prune-skill");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV2);
      expect(existsSync(join(root, "references", "old.md"))).toBe(false);
      expect(existsSync(join(root, "references", "nested"))).toBe(false);
      expect(readFileSync(join(root, "references", "keep.md"), "utf8")).toBe("keep-v2");
      expect(readFileSync(outside, "utf8")).toBe("outside");
    });
  });

  test("更新省略 files 會保留舊附檔", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const contentV1 = "---\nname: keep-files\ndescription: 保留附檔\n---\n\n# v1\n";
      const contentV2 = "---\nname: keep-files\ndescription: 保留附檔\n---\n\n# v2\n";
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "keep-files",
            title: "保留附檔",
            description: "保留附檔",
            content: contentV1,
            files: [
              { path: "references/keep-a.md", content: "a" },
              { path: "references/keep-b.md", content: "b" },
            ],
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
            knowledgeId: "keep-files",
            content: contentV2,
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      const root = join(fixture.repo, ".agents", "skills", "keep-files");
      expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(contentV2);
      expect(readFileSync(join(root, "references", "keep-a.md"), "utf8")).toBe("a");
      expect(readFileSync(join(root, "references", "keep-b.md"), "utf8")).toBe("b");
    });
  });

  test("更新明確傳 files: [] 會清空舊附檔", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "---\nname: clear-files\ndescription: 清空附檔\n---\n\n# v1\n";
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "clear-files",
            title: "清空附檔",
            description: "清空附檔",
            content,
            files: [
              { path: "references/old-a.md", content: "a" },
              { path: "references/nested/old-b.md", content: "b" },
            ],
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
            knowledgeId: "clear-files",
            content,
            files: [],
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );

      const root = join(fixture.repo, ".agents", "skills", "clear-files");
      expect(existsSync(join(root, "SKILL.md"))).toBe(true);
      expect(existsSync(join(root, "references"))).toBe(false);
    });
  });

  test("技能可從 frontmatter 補 title 與 description", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "---\nname: inferred-skill\ndescription: 從 frontmatter 取得\n---\n\n# Inferred\n";
      const data = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "global",
            knowledgeId: "inferred-skill",
            content,
          },
          fixture,
        ),
      );

      expect(data.entry.title).toBe("inferred-skill");
      expect(data.entry.description).toBe("從 frontmatter 取得");
      expect(data.entry.type).toBe("document");
    });
  });

  test("全域技能寫到使用者家目錄的 .agents/skills", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "---\nname: global-skill\ndescription: 全域技能\n---\n\n# Global\n";
      const data = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "global",
            knowledgeId: "global-skill",
            title: "全域技能",
            description: "全域技能",
            content,
          },
          fixture,
        ),
      );

      const expected = join(fixture.root, "home", ".agents", "skills", "global-skill");
      expect(realpathSync(data.artifactPath)).toBe(realpathSync(expected));
      expect(readFileSync(join(expected, "SKILL.md"), "utf8")).toBe(content);
      expect(data.entry.layer).toBe("global");
      expect(data.entry.projectId).toBeNull();
    });
  });

  test("expectedVersion 過期回 VERSION_CONFLICT，且不產生新版本", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "edit-topic",
            title: "編輯測試",
            description: "版本測試",
            content: "# 第一版\n",
          },
          fixture,
        ),
      );

      const second = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "edit-topic",
            title: "編輯測試",
            description: "版本測試",
            content: "# 第二版\n",
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );
      expect(second.entry.currentVersion).toBe(2);

      const stale = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "edit-topic",
            title: "編輯測試",
            description: "版本測試",
            content: "# 第三版\n",
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );
      expect(stale.code).toBe("VERSION_CONFLICT");
      expect(stale.data).toMatchObject({ expectedVersion: 1, actualVersion: 2 });

      const { entry, versions } = withDatabase(fixture, (db) => {
        const found = findKnowledgeEntry(db, "edit-topic", "project", fixture.project.projectId)!;
        return { entry: found, versions: listKnowledgeVersions(db, found.id) };
      });
      expect(entry.currentVersion).toBe(2);
      expect(versions).toHaveLength(2);

      const filePath = join(fixture.home, "memory", "projects", fixture.project.projectId, "topics", "edit-topic.md");
      expect(readFileSync(filePath, "utf8")).toContain("# 第二版");
      expect(readFileSync(filePath, "utf8")).not.toContain("# 第三版");
    });
  });

  test("更新時省略 title、description、pinned、tags 與 source 會保留原值", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const first = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "preserve-meta",
            title: "保留標題",
            description: "保留描述",
            content: "# v1\n",
            pinned: true,
            tags: ["keep-b", "keep-a"],
            source: "custom-source",
          },
          fixture,
        ),
      );

      const second = dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "project",
            knowledgeId: "preserve-meta",
            content: "# v2\n",
            expectedVersion: first.entry.version,
          },
          fixture,
        ),
      );
      expect(second.entry.title).toBe("保留標題");
      expect(second.entry.description).toBe("保留描述");
      expect(second.entry.pinned).toBe(true);
      expect(second.entry.tags).toEqual(["keep-a", "keep-b"]);
      expect(second.entry.source).toBe("custom-source");
      expect(second.entry.currentVersion).toBe(2);
    });
  });

  test("靜態檢查不合格時不落地、不建版本，並指出欄位", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const secret = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "secret-topic",
            title: "機密測試",
            content: `設定值：${FAKE_AWS_KEY}`,
          },
          fixture,
        ),
      );
      expect(secret.code).toBe("KNOWLEDGE_CHECK_FAILED");
      expect(secret.data.field).toBe("content");
      expect(secret.data.errors).toContainEqual(
        expect.objectContaining({ code: "SECRET_DETECTED", field: "content" }),
      );
      expect(existsSync(join(fixture.home, "memory", "topics", "secret-topic.md"))).toBe(false);
      expect(countRows(fixture, "knowledge_entries")).toBe(0);
      expect(countRows(fixture, "knowledge_versions")).toBe(0);

      const missingDescription = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "invalid-skill",
            title: "不合格技能",
            description: "",
            content: "# 沒有 description\n",
          },
          fixture,
        ),
      );
      expect(missingDescription.code).toBe("KNOWLEDGE_CHECK_FAILED");
      expect(missingDescription.data.errors).toContainEqual(
        expect.objectContaining({ field: "description" }),
      );
      expect(existsSync(join(fixture.repo, ".agents", "skills", "invalid-skill"))).toBe(false);
      expect(countRows(fixture, "knowledge_entries")).toBe(0);
    });
  });

  test("標題與來源的機密也會被拒絕", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const titleSecret = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "secret-title",
            title: `標題 ${FAKE_AWS_KEY}`,
            content: "安全內容",
          },
          fixture,
        ),
      );
      expect(titleSecret.code).toBe("KNOWLEDGE_CHECK_FAILED");
      expect(titleSecret.data.errors).toContainEqual(
        expect.objectContaining({ code: "SECRET_DETECTED", field: "title" }),
      );
      expect(existsSync(join(fixture.home, "memory", "topics", "secret-title.md"))).toBe(false);

      const sourceSecret = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "secret-source",
            title: "來源測試",
            source: `manual ${FAKE_AWS_KEY}`,
            content: "安全內容",
          },
          fixture,
        ),
      );
      expect(sourceSecret.code).toBe("KNOWLEDGE_CHECK_FAILED");
      expect(sourceSecret.data.errors).toContainEqual(
        expect.objectContaining({ code: "SECRET_DETECTED", field: "source" }),
      );
      expect(existsSync(join(fixture.home, "memory", "topics", "secret-source.md"))).toBe(false);
      expect(countRows(fixture, "knowledge_entries")).toBe(0);
      expect(countRows(fixture, "knowledge_versions")).toBe(0);
    });
  });

  test("tags、reason 與 sourceSignalIds 的機密也會被拒絕", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const result = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "secret-metadata",
            title: "metadata 掃描",
            tags: [`tag-${FAKE_AWS_KEY}`],
            reason: `reason ${FAKE_AWS_KEY}`,
            sourceSignalIds: [`sig-${FAKE_AWS_KEY}`],
            content: "安全內容",
          },
          fixture,
        ),
      );

      expect(result.code).toBe("KNOWLEDGE_CHECK_FAILED");
      for (const field of ["tags", "reason", "sourceSignalIds"]) {
        expect(result.data.errors).toContainEqual(
          expect.objectContaining({ code: "SECRET_DETECTED", field }),
        );
      }
      expect(existsSync(join(fixture.home, "memory", "topics", "secret-metadata.md"))).toBe(false);
      expect(countRows(fixture, "knowledge_entries")).toBe(0);
    });
  });

  test("附檔路徑的機密錯誤會映射回 files 欄位", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const result = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "memory",
            layer: "global",
            knowledgeId: "secret-path",
            title: "路徑掃描",
            content: "安全內容",
            files: [{ path: `references/${FAKE_AWS_KEY}.md`, content: "safe" }],
          },
          fixture,
        ),
      );

      expect(result.code).toBe("KNOWLEDGE_CHECK_FAILED");
      expect(result.data.errors).toContainEqual(
        expect.objectContaining({
          code: "SECRET_DETECTED",
          field: "files[0].path",
        }),
      );
      expect(existsSync(join(fixture.home, "memory", "topics", "secret-path.md"))).toBe(false);
    });
  });

  test("跨層同名技能被拒絕", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const content = "---\nname: shared-skill\ndescription: 共用名稱\n---\n\n# Shared\n";
      dataOf<WriteData>(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "project",
            knowledgeId: "shared-skill",
            title: "共用技能",
            description: "共用名稱",
            content,
          },
          fixture,
        ),
      );

      const conflict = failureOf(
        await callTool(
          knowledgeWrite,
          {
            kind: "skill",
            layer: "global",
            knowledgeId: "shared-skill",
            title: "共用技能",
            description: "共用名稱",
            content,
          },
          fixture,
        ),
      );
      expect(conflict.code).toBe("KNOWLEDGE_LAYER_CONFLICT");
      expect(conflict.data.field).toBe("name");
      expect(existsSync(join(fixture.root, "home", ".agents", "skills", "shared-skill"))).toBe(false);

      const globalCount = withDatabase(
        fixture,
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM knowledge_entries WHERE layer = 'global' AND knowledge_id = ?",
            )
            .get("shared-skill")?.count ?? 0,
      );
      expect(globalCount).toBe(0);
    });
  });

  test("同一個 idempotencyKey 重送不重複建立版本或檔案", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      const input = {
        kind: "memory",
        layer: "global",
        knowledgeId: "idem-topic",
        title: "冪等測試",
        content: "# 只寫一次\n",
        idempotencyKey: "write-once",
      };
      const first = dataOf<WriteData>(await callTool(knowledgeWrite, input, fixture));
      const replay = dataOf<WriteData>(await callTool(knowledgeWrite, input, fixture));

      expect(replay.entry.id).toBe(first.entry.id);
      expect(replay.entry.currentVersion).toBe(1);
      expect(replay.idempotentReplay).toBe(true);
      expect(countRows(fixture, "knowledge_versions")).toBe(1);
      expect(countRows(fixture, "idempotency_keys")).toBe(1);

      const conflict = failureOf(
        await callTool(knowledgeWrite, { ...input, content: "# 不同內容\n" }, fixture),
      );
      expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(countRows(fixture, "knowledge_versions")).toBe(1);
      expect(readFileSync(join(fixture.home, "memory", "topics", "idem-topic.md"), "utf8")).toContain(
        "# 只寫一次",
      );
    });
  });
});
