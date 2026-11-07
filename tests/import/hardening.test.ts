import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { insertTestProject } from "../helpers/db.ts";
import { openDatabase } from "../../src/db/index.ts";
import { exportCurrent } from "../../src/export/current/index.ts";
import { ImportError, importPackage } from "../../src/import/index.ts";
import { validatePackage } from "../export-format/helpers/package.ts";
import { writePackage } from "../export-format/helpers/writer.ts";
import type { PackageInput } from "../export-format/helpers/types.ts";
import { withTempHome } from "../helpers/temp.ts";
import {
  FIXED_CREATED_AT,
  buildV3Package,
  makeTempDir,
  readJsonLines,
  removeDir,
  sha256Bytes,
} from "./helpers.ts";

const repoRoot = `${import.meta.dir}/../..`;

function knowledgePackage(root: string): void {
  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: { kind: "ultrawork-v3", projectId: "retired-project", layers: ["project"] },
    work: [],
    events: [],
    evidence: [],
    signals: [],
    knowledge: [
      {
        knowledgeId: "k-retired",
        type: "reference",
        layer: "project",
        title: "已退役知識",
        description: "匯出時不能靜默消失",
        pinned: false,
        source: "manual",
        currentVersion: 1,
        versions: [{ version: 1, body: "## 已退役\n內容\n" }],
      },
    ],
    mapping: [],
    raw: [],
  };
  writePackage(root, input, FIXED_CREATED_AT);
}

function rawNotePackage(root: string): void {
  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: { kind: "ultrawork-v3", projectId: "raw-note-project", layers: ["project"] },
    work: [],
    events: [],
    evidence: [],
    signals: [],
    knowledge: [],
    mapping: [
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "tasks.json",
        targetId: "raw/project/tasks.json",
        sourceRef: "raw/project/tasks.json",
        sha256: "0".repeat(64),
        note: "原始檔名：設定 檔.json",
      },
    ],
    raw: [{ layer: "project", path: "tasks.json", body: "{}" }],
  };
  writePackage(root, input, FIXED_CREATED_AT);
}

function evidenceSymlinkPackage(root: string, secretSha: string): void {
  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: { kind: "ultrawork-v3", projectId: "evidence-project", layers: ["project"] },
    work: [
      {
        workId: "w-evidence",
        kind: "task",
        title: "證據工作",
        status: "open",
        owner: "build",
        priority: "medium",
      },
    ],
    events: [],
    evidence: [
      {
        evidenceId: "ev-raw",
        workId: "w-evidence",
        kind: "artifact",
        actor: "build",
        summary: "raw 證據",
        path: "raw/project/tasks.json",
        sha256: secretSha,
      },
      {
        evidenceId: "ev-knowledge",
        workId: "w-evidence",
        kind: "artifact",
        actor: "build",
        summary: "knowledge 證據",
        path: "knowledge/files/k-evidence/v1.md",
        sha256: secretSha,
      },
    ],
    signals: [],
    knowledge: [
      {
        knowledgeId: "k-evidence",
        type: "reference",
        layer: "project",
        title: "證據知識",
        description: "",
        pinned: false,
        source: "manual",
        currentVersion: 1,
        versions: [{ version: 1, body: "正常內容\n" }],
      },
    ],
    mapping: [
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "tasks.json",
        targetId: "raw/project/tasks.json",
        sourceRef: "raw/project/tasks.json",
        sha256: "0".repeat(64),
      },
    ],
    raw: [{ layer: "project", path: "tasks.json", body: "{}" }],
  };
  writePackage(root, input, FIXED_CREATED_AT);
}

function workPackage(root: string): void {
  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: { kind: "ultrawork-v3", projectId: "work-project", layers: ["project"] },
    work: [
      {
        workId: "w-long",
        kind: "task",
        title: "長欄位工作",
        status: "open",
        owner: "build",
        priority: "medium",
      },
    ],
    events: [],
    evidence: [],
    signals: [],
    knowledge: [],
    mapping: [],
    raw: [],
  };
  writePackage(root, input, FIXED_CREATED_AT);
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, join(repoRoot, "src/cli/index.ts"), ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function replaceWithSymlink(path: string, target: string, type: "dir" | "file"): void {
  rmSync(path, { recursive: true, force: true });
  symlinkSync(target, path, type);
}

describe("匯入與匯出的資料邊界", () => {
  test("manifest.json 是 symlink 時整包拒絕，不讀外部內容", async () => {
    const fixture = buildV3Package();
    const external = makeTempDir("manifest-external");
    try {
      const manifest = JSON.parse(
        readFileSync(join(fixture.packageDir, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      manifest.source = {
        ...(manifest.source as Record<string, unknown>),
        projectId: "external-project",
      };
      const externalManifest = join(external, "manifest.json");
      writeFileSync(externalManifest, JSON.stringify(manifest), "utf8");
      replaceWithSymlink(join(fixture.packageDir, "manifest.json"), externalManifest, "file");

      await withTempHome("manifest-symlink", async (home) => {
        try {
          importPackage({ packageDir: fixture.packageDir, home });
          throw new Error("應該要拒絕 symlink manifest");
        } catch (error) {
          expect(error).toBeInstanceOf(ImportError);
          expect((error as ImportError).code).toBe("MANIFEST_SYMLINK");
        }
        expect(existsSync(join(home, "smilework.db"))).toBe(false);
      });
    } finally {
      removeDir(external);
      fixture.cleanup();
    }
  });

  test("核心 jsonl 是 symlink 時跳過該檔並 warning，不讀外部內容", async () => {
    const fixture = buildV3Package();
    const external = makeTempDir("core-file-external");
    try {
      const externalWork = join(external, "work.jsonl");
      writeFileSync(
        externalWork,
        `${JSON.stringify({
          kind: "task",
          owner: "external",
          priority: "medium",
          status: "open",
          title: "外部工作",
          workId: "external-work",
        })}\n`,
        "utf8",
      );
      replaceWithSymlink(join(fixture.packageDir, "work.jsonl"), externalWork, "file");

      await withTempHome("core-file-symlink", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home });
        expect(result.inserted.work).toBe(0);
        expect(
          result.warnings.some(
            (warning) =>
              warning.includes("CORE_FILE_SYMLINK_SKIPPED") && warning.includes("work.jsonl"),
          ),
        ).toBe(true);
        const db = openDatabase({ home });
        try {
          expect(
            db
              .query<{ total: number }, []>("SELECT COUNT(*) AS total FROM work_items")
              .get()!.total,
          ).toBe(0);
          expect(
            db
              .query<{ total: number }, []>(
                "SELECT COUNT(*) AS total FROM work_items WHERE work_id = 'external-work'",
              )
              .get()!.total,
          ).toBe(0);
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(external);
      fixture.cleanup();
    }
  });

  test("raw 根目錄是 symlink 時跳過並 warning", async () => {
    const fixture = buildV3Package();
    const external = makeTempDir("raw-root-external");
    try {
      writeFileSync(join(external, "secret.txt"), "外部秘密", "utf8");
      replaceWithSymlink(join(fixture.packageDir, "raw"), external, "dir");

      await withTempHome("raw-root-symlink", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home });
        expect(result.inserted.raw).toBe(0);
        expect(result.warnings.some((warning) => warning.includes("SYMLINK_SKIPPED"))).toBe(true);
        expect(result.warnings.some((warning) => warning.includes("raw"))).toBe(true);
        const db = openDatabase({ home });
        try {
          expect(
            db
              .query<{ total: number }, []>(
                "SELECT COUNT(*) AS total FROM id_mappings WHERE entity = 'raw'",
              )
              .get()!.total,
          ).toBe(0);
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(external);
      fixture.cleanup();
    }
  });

  test("raw/project 是 symlink 時跳過該層並 warning", async () => {
    const fixture = buildV3Package();
    const external = makeTempDir("raw-layer-external");
    try {
      writeFileSync(join(external, "secret.txt"), "外部秘密", "utf8");
      replaceWithSymlink(join(fixture.packageDir, "raw", "project"), external, "dir");

      await withTempHome("raw-layer-symlink", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home });
        expect(result.inserted.raw).toBe(0);
        expect(
          result.warnings.some(
            (warning) => warning.includes("SYMLINK_SKIPPED") && warning.includes("raw/project"),
          ),
        ).toBe(true);
      });
    } finally {
      removeDir(external);
      fixture.cleanup();
    }
  });

  test("evidence artifact 指向 symlink 的 raw 或 knowledge 時跳過且不讀外部", async () => {
    const root = makeTempDir("evidence-symlink");
    const packageDir = join(root, "package");
    const external = makeTempDir("evidence-external");
    try {
      const secret = "外部內容不應被 evidence 讀取";
      const secretSha = sha256Bytes(Buffer.from(secret, "utf8"));
      evidenceSymlinkPackage(packageDir, secretSha);
      const externalSecret = join(external, "secret.txt");
      writeFileSync(externalSecret, secret, "utf8");
      replaceWithSymlink(join(packageDir, "raw", "project", "tasks.json"), externalSecret, "file");
      replaceWithSymlink(
        join(packageDir, "knowledge", "files", "k-evidence", "v1.md"),
        externalSecret,
        "file",
      );

      await withTempHome("evidence-symlink-home", async (home) => {
        const result = importPackage({ packageDir, home });
        expect(result.inserted.evidence).toBe(0);
        expect(
          result.warnings.filter((warning) => warning.includes("EVIDENCE_PATH_UNSAFE")).length,
        ).toBe(2);
        const db = openDatabase({ home });
        try {
          expect(
            db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM evidence").get()!.total,
          ).toBe(0);
          expect(
            db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM knowledge_versions")
              .get()!.total,
          ).toBe(0);
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(external);
      removeDir(root);
    }
  });

  test("knowledge 版本檔是 symlink 時不讀取外部內容", async () => {
    const fixture = buildV3Package();
    const external = makeTempDir("knowledge-file-external");
    try {
      const secret = join(external, "secret.txt");
      writeFileSync(secret, "外部秘密不應被讀取", "utf8");
      const knowledge = readJsonLines(
        join(fixture.packageDir, "knowledge", "index.jsonl"),
      )[0]!;
      const knowledgeId = String(knowledge.knowledgeId);
      replaceWithSymlink(
        join(fixture.packageDir, "knowledge", "files", knowledgeId, "v1.md"),
        secret,
        "file",
      );

      await withTempHome("knowledge-file-symlink", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home });
        expect(result.inserted.knowledge).toBe(0);
        expect(result.inserted.knowledgeVersions).toBe(0);
        expect(
          result.warnings.some((warning) => warning.includes("KNOWLEDGE_SYMLINK_SKIPPED")),
        ).toBe(true);
        const db = openDatabase({ home });
        try {
          expect(
            db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM knowledge_versions")
              .get()!.total,
          ).toBe(0);
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(external);
      fixture.cleanup();
    }
  });

  test("knowledge 版本的上層資料夾是 symlink 時不讀取外部內容", async () => {
    const fixture = buildV3Package();
    const external = makeTempDir("knowledge-dir-external");
    try {
      writeFileSync(join(external, "v1.md"), "外部目錄版本內容", "utf8");
      const knowledge = readJsonLines(
        join(fixture.packageDir, "knowledge", "index.jsonl"),
      )[0]!;
      const knowledgeId = String(knowledge.knowledgeId);
      replaceWithSymlink(
        join(fixture.packageDir, "knowledge", "files", knowledgeId),
        external,
        "dir",
      );

      await withTempHome("knowledge-dir-symlink", async (home) => {
        const result = importPackage({ packageDir: fixture.packageDir, home });
        expect(result.inserted.knowledge).toBe(0);
        expect(
          result.warnings.some((warning) => warning.includes("KNOWLEDGE_SYMLINK_SKIPPED")),
        ).toBe(true);
      });
    } finally {
      removeDir(external);
      fixture.cleanup();
    }
  });

  test("全域訊號匯出再匯入後仍是 global，status/refs/reason 不丟失", async () => {
    const root = makeTempDir("global-signal");
    const exportDir = join(root, "export");
    const firstHome = join(root, "first-home", ".smilework");
    const secondHome = join(root, "second-home", ".smilework");
    try {
      const db = openDatabase({ home: firstHome });
      try {
        const projectId = insertTestProject(db, "global-project");
        const now = new Date().toISOString();
        db.query(
          `INSERT INTO signals (
             signal_id, project_id, scope, kind, content, status, work_id,
             refs, result_refs, reason, details, severity, code, actor,
             created_at, updated_at, updated_by
           ) VALUES (?, NULL, 'global', 'decision', ?, 'accepted', NULL,
             '["ref-1"]', '["result-1"]', ?, ?, ?, 'GLOBAL_SIGNAL', 'tester', ?, ?, 'tester')`,
        ).run(
          "s-global",
          "全域訊號內容",
          "保留原因",
          JSON.stringify({ tag: "scope" }),
          "warning",
          now,
          now,
        );
        expect(projectId).toBe("global-project");
      } finally {
        db.close();
      }

      const exported = exportCurrent({
        outDir: exportDir,
        home: firstHome,
        createdAt: FIXED_CREATED_AT,
      });
      validatePackage(exported.outDir);
      expect(exported.manifest.source.layers).toContain("global");
      const signal = readJsonLines(join(exportDir, "signals.jsonl"))[0]!;
      const details = signal.details as Record<string, unknown>;
      const internal = details.smileworkExport as Record<string, unknown>;
      expect(internal.scope).toBe("global");
      expect(internal.status).toBe("accepted");
      expect(internal.refs).toEqual(["ref-1"]);
      expect(internal.resultRefs).toEqual(["result-1"]);
      expect(internal.reason).toBe("保留原因");

      importPackage({ packageDir: exportDir, home: secondHome });
      const imported = openDatabase({ home: secondHome });
      try {
        const row = imported
          .query<
            {
              scope: string;
              project_id: string | null;
              status: string;
              refs: string;
              result_refs: string;
              reason: string | null;
              details: string | null;
              severity: string | null;
              code: string | null;
            },
            []
          >(
            "SELECT scope, project_id, status, refs, result_refs, reason, details, severity, code FROM signals WHERE signal_id = 's-global'",
          )
          .get();
        expect(row?.scope).toBe("global");
        expect(row?.project_id).toBeNull();
        expect(row?.status).toBe("accepted");
        expect(JSON.parse(row!.refs)).toEqual(["ref-1"]);
        expect(JSON.parse(row!.result_refs)).toEqual(["result-1"]);
        expect(row?.reason).toBe("保留原因");
        expect(JSON.parse(row!.details!)).toEqual({ tag: "scope" });
        expect(row?.severity).toBe("warning");
        expect(row?.code).toBe("GLOBAL_SIGNAL");
      } finally {
        imported.close();
      }
    } finally {
      removeDir(root);
    }
  });

  test("--force 不能指向家目錄或 SMILEWORK_HOME", async () => {
    const fakeHome = makeTempDir("force-home");
    const smileHome = join(fakeHome, ".smilework");
    const marker = join(fakeHome, "keep.txt");
    const fixture = buildV3Package();
    try {
      writeFileSync(marker, "不要刪除", "utf8");
      importPackage({ packageDir: fixture.packageDir, home: smileHome });
      expect(existsSync(join(smileHome, "smilework.db"))).toBe(true);

      const env = { ...process.env, HOME: fakeHome, SMILEWORK_HOME: smileHome };
      const homeResult = await runCli(["export", "--force", "--out", "~"], env);
      expect(homeResult.exitCode).toBe(1);
      expect(homeResult.stderr).toContain("輸出位置");
      expect(readFileSync(marker, "utf8")).toBe("不要刪除");

      const smileResult = await runCli(["export", "--force", "--out", "~/.smilework"], env);
      expect(smileResult.exitCode).toBe(1);
      expect(smileResult.stderr).toContain("輸出位置");
      expect(existsSync(join(smileHome, "smilework.db"))).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("不要刪除");
    } finally {
      fixture.cleanup();
      removeDir(fakeHome);
    }
  });

  test("retired knowledge 匯出時保留並 warning，不會靜默消失", async () => {
    const root = makeTempDir("retired-knowledge");
    const packageDir = join(root, "package");
    const exportDir = join(root, "export");
    const secondHome = join(root, "second-home", ".smilework");
    try {
      knowledgePackage(packageDir);
      await withTempHome("retired-knowledge-home", async (home) => {
        importPackage({ packageDir, home });
        const db = openDatabase({ home });
        try {
          db.query("UPDATE knowledge_entries SET status = 'retired' WHERE knowledge_id = ?").run(
            "k-retired",
          );
        } finally {
          db.close();
        }

        const exported = exportCurrent({
          outDir: exportDir,
          home,
          createdAt: FIXED_CREATED_AT,
        });
        validatePackage(exported.outDir);
        expect(
          exported.manifest.warnings.some((warning) => warning.includes("RETIRED_KNOWLEDGE")),
        ).toBe(true);
        const knowledge = readJsonLines(join(exportDir, "knowledge", "index.jsonl"));
        expect(knowledge.map((entry) => entry.knowledgeId)).toContain("k-retired");
      });

      importPackage({ packageDir: exportDir, home: secondHome });
      const imported = openDatabase({ home: secondHome });
      try {
        const row = imported
          .query<{ status: string }, [string]>(
            "SELECT status FROM knowledge_entries WHERE knowledge_id = ?",
          )
          .get("k-retired");
        expect(row?.status).toBe("active");
      } finally {
        imported.close();
      }
    } finally {
      removeDir(root);
    }
  });

  test("超長 work 欄位被濾掉時留下 warning", async () => {
    const root = makeTempDir("work-long-fields");
    const packageDir = join(root, "package");
    const exportDir = join(root, "export");
    try {
      workPackage(packageDir);
      await withTempHome("work-long-fields-home", async (home) => {
        importPackage({ packageDir, home });
        const db = openDatabase({ home });
        try {
          db.query(
            `UPDATE work_items
                SET non_goals = ?, context_refs = ?, scope_paths = ?, acceptance = ?, objective = ?
              WHERE work_id = 'w-long'`,
          ).run(
            JSON.stringify(["n".repeat(600)]),
            JSON.stringify(["c".repeat(600)]),
            JSON.stringify(["s".repeat(600)]),
            JSON.stringify(["a".repeat(1100)]),
            "o".repeat(2500),
          );
        } finally {
          db.close();
        }

        const exported = exportCurrent({
          outDir: exportDir,
          home,
          createdAt: FIXED_CREATED_AT,
        });
        validatePackage(exported.outDir);
        for (const field of ["nonGoals", "contextRefs", "scopePaths", "acceptance"]) {
          expect(
            exported.manifest.warnings.some(
              (warning) =>
                warning.includes("DATABASE_WORK_FIELD_TOO_LONG") && warning.includes(field),
            ),
          ).toBe(true);
        }
        expect(
          exported.manifest.warnings.some((warning) =>
            warning.includes("DATABASE_OBJECTIVE_TOO_LONG"),
          ),
        ).toBe(true);
      });
    } finally {
      removeDir(root);
    }
  });

  test("raw mapping 的原始 note 會保留", async () => {
    const root = makeTempDir("raw-note");
    const packageDir = join(root, "package");
    const exportDir = join(root, "export");
    try {
      rawNotePackage(packageDir);
      await withTempHome("raw-note-home", async (home) => {
        importPackage({ packageDir, home });
        const db = openDatabase({ home });
        try {
          const mapping = db
            .query<{ note: string | null }, []>(
              "SELECT note FROM id_mappings WHERE entity = 'raw'",
            )
            .get();
          expect(mapping?.note).toBe("原始檔名：設定 檔.json");
        } finally {
          db.close();
        }

        const exported = exportCurrent({
          outDir: exportDir,
          home,
          createdAt: FIXED_CREATED_AT,
        });
        validatePackage(exported.outDir);
        const rawMapping = readJsonLines(join(exportDir, "mapping.jsonl")).find(
          (record) => record.entity === "raw",
        );
        expect(rawMapping?.note).toBe("原始檔名：設定 檔.json");
      });
    } finally {
      removeDir(root);
    }
  });
});
