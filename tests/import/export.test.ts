import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exportCurrent } from "../../src/export/current/index.ts";
import { importPackage } from "../../src/import/index.ts";
import { openDatabase } from "../../src/db/index.ts";
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
  scanHashes,
  sha256Bytes,
  stripSignalsInternal,
} from "./helpers.ts";

const repoRoot = `${import.meta.dir}/../..`;

function craftedPackage(root: string): void {
  const tasks = JSON.stringify({ tasks: [] });
  const notes = "# 來源筆記\n";
  const globalNotes = "# 全域筆記\n";

  const input: PackageInput = {
    producer: { name: "smilework", version: "0.1.0" },
    source: {
      kind: "ultrawork-v3",
      projectId: "crafted-project",
      layers: ["project", "global"],
    },
    work: [
      {
        workId: "w-task-1",
        kind: "task",
        title: "工作一",
        status: "in_progress",
        owner: "build",
        priority: "high",
        dependsOn: ["w-task-2"],
        objective: "完成匯入與匯出",
        nonGoals: ["不做雲端同步"],
        contextRefs: ["knowledge:k-note", "raw/project/tasks.json"],
        scopePaths: ["src/import", "src/export/current"],
        acceptance: ["條件一", "條件二"],
        risk: "high",
        review: {
          verdict: "concerns",
          reviewer: "momus",
          note: "補上邊際情況",
          reworkedAfterReview: true,
        },
        acceptanceResults: {
          recordedBy: "build",
          items: [
            { criterion: "條件一", met: true, evidence: "測試通過" },
            { criterion: "條件二", met: false },
          ],
        },
      },
      {
        workId: "w-task-2",
        kind: "task",
        title: "工作二",
        status: "done",
        resolution: "completed",
        owner: "build",
        priority: "medium",
      },
    ],
    events: [
      {
        eventId: "e-1",
        sequence: 1,
        kind: "created",
        actor: "build",
        workId: "w-task-1",
        toStatus: "open",
        details: { source: "crafted" },
      },
      {
        eventId: "e-2",
        sequence: 2,
        kind: "status_changed",
        actor: "build",
        workId: "w-task-2",
        fromStatus: "in_progress",
        toStatus: "done",
        resolution: "completed",
        summary: "完成",
      },
      { eventId: "e-3", sequence: 3, kind: "note", actor: "system", summary: "專案層級筆記" },
    ],
    evidence: [
      {
        evidenceId: "ev-1",
        workId: "w-task-1",
        kind: "test",
        actor: "build",
        summary: "測試通過",
        command: "bun test tests/import",
        output: "通過",
      },
      {
        evidenceId: "ev-2",
        workId: "w-task-2",
        kind: "artifact",
        actor: "build",
        summary: "任務清單",
        path: "raw/project/tasks.json",
        sha256: sha256Bytes(Buffer.from(tasks, "utf8")),
      },
      {
        evidenceId: "ev-3",
        workId: "w-task-1",
        kind: "link",
        actor: "build",
        summary: "相關討論",
        url: "https://example.invalid/discussion",
      },
    ],
    signals: [
      {
        signalId: "s-1",
        severity: "warning",
        code: "MIGRATED_WARNING",
        message: "舊資料需要人工確認",
        workId: "w-task-1",
        details: { legacy: true },
      },
      {
        signalId: "s-2",
        severity: "info",
        code: "PROJECT_NOTE",
        message: "專案層級訊號",
      },
    ],
    knowledge: [
      {
        knowledgeId: "k-note",
        type: "decision",
        layer: "project",
        title: "匯入決策",
        description: "匯入格式的決策",
        pinned: true,
        source: "manual",
        currentVersion: 1,
        versions: [{ version: 1, body: "## 決策\n保留原順序。\n" }],
        workId: "w-task-1",
        tags: ["format", "import"],
      },
      {
        knowledgeId: "k-global",
        type: "reference",
        layer: "global",
        title: "全域參考",
        description: "",
        pinned: false,
        source: "manual",
        currentVersion: 2,
        versions: [
          { version: 1, body: "## 第一版\n" },
          { version: 2, body: "## 第二版\n" },
        ],
        tags: ["global"],
      },
    ],
    mapping: [
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-1",
        sourceRecord: "/tasks/t-1",
        targetId: "w-task-1",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-2",
        sourceRecord: "/tasks/t-2",
        targetId: "w-task-2",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "event",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "audit:0",
        sourceRecord: "/0",
        targetId: "e-1",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "evidence",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "evidence:ev-1",
        sourceRecord: "/0",
        targetId: "ev-1",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "signal",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "signal:s-1",
        sourceRecord: "/0",
        targetId: "s-1",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "knowledge",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "note",
        sourceRecord: "frontmatter",
        targetId: "k-note",
        sourceRef: "raw/project/notes.md",
      },
      {
        entity: "knowledge",
        layer: "global",
        sourceRoot: "raw/global",
        sourceId: "global-note",
        sourceRecord: "frontmatter",
        targetId: "k-global",
        sourceRef: "raw/global/notes.md",
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "tasks.json",
        targetId: "raw/project/tasks.json",
        sourceRef: "raw/project/tasks.json",
        sha256: "0".repeat(64),
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "notes.md",
        targetId: "raw/project/notes.md",
        sourceRef: "raw/project/notes.md",
        sha256: "0".repeat(64),
      },
      {
        entity: "raw",
        layer: "global",
        sourceRoot: "raw/global",
        sourceId: "notes.md",
        targetId: "raw/global/notes.md",
        sourceRef: "raw/global/notes.md",
        sha256: "0".repeat(64),
      },
    ],
    raw: [
      { layer: "project", path: "tasks.json", body: tasks },
      { layer: "project", path: "notes.md", body: notes },
      { layer: "global", path: "notes.md", body: globalNotes },
    ],
  };

  writePackage(root, input, FIXED_CREATED_AT);
}

function sortedById(
  records: readonly Record<string, unknown>[],
  key: string,
): Record<string, unknown>[] {
  return [...records].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

describe("目前資料庫匯出完整格式", () => {
  test("evidence、signals、規劃欄位與多版本知識可以往返", async () => {
    const root = makeTempDir("import-export");
    const packageDir = join(root, "package");
    try {
      craftedPackage(packageDir);
      expect(validatePackage(packageDir).evidence.length).toBe(3);

      const packageHashes = scanHashes(packageDir);
      await withTempHome("import-export-home", async (home, homeRoot) => {
        importPackage({ packageDir, home });
        const result = exportCurrent({
          outDir: join(homeRoot, "export"),
          home,
          createdAt: FIXED_CREATED_AT,
        });

        const validated = validatePackage(result.outDir);
        expect(validated.manifest.source.layers).toEqual(["project", "global"]);

        expect(sortedById(readJsonLines(join(result.outDir, "work.jsonl")), "workId")).toEqual(
          sortedById(readJsonLines(join(packageDir, "work.jsonl")), "workId"),
        );
        expect(sortedById(readJsonLines(join(result.outDir, "events.jsonl")), "eventId")).toEqual(
          sortedById(readJsonLines(join(packageDir, "events.jsonl")), "eventId"),
        );
        expect(
          sortedById(readJsonLines(join(result.outDir, "evidence.jsonl")), "evidenceId"),
        ).toEqual(sortedById(readJsonLines(join(packageDir, "evidence.jsonl")), "evidenceId"));
        expect(
          sortedById(
            stripSignalsInternal(readJsonLines(join(result.outDir, "signals.jsonl"))),
            "signalId",
          ),
        ).toEqual(
          sortedById(
            stripSignalsInternal(readJsonLines(join(packageDir, "signals.jsonl"))),
            "signalId",
          ),
        );
        expect(
          sortedById(readJsonLines(join(result.outDir, "knowledge", "index.jsonl")), "knowledgeId"),
        ).toEqual(
          sortedById(
            readJsonLines(join(packageDir, "knowledge", "index.jsonl")),
            "knowledgeId",
          ),
        );

        for (const rootName of ["project", "global"] as const) {
          for (const relative of ["tasks.json", "notes.md"] as const) {
            const path = join(result.outDir, "raw", rootName, relative);
            const source = join(packageDir, "raw", rootName, relative);
            if (!existsSync(source)) continue;
            expect(readFileSync(path)).toEqual(readFileSync(source));
          }
        }
      });

      expect(scanHashes(packageDir)).toEqual(packageHashes);
    } finally {
      removeDir(root);
    }
  });

  test("含 evidence 與 signals 的同一包匯入兩次不新增資料", async () => {
    const root = makeTempDir("import-crafted-twice");
    const packageDir = join(root, "package");
    try {
      craftedPackage(packageDir);
      await withTempHome("import-crafted-twice-home", async (home) => {
        importPackage({ packageDir, home });
        const db = openDatabase({ home });
        try {
          const count = (table: string): number =>
            db.query<{ total: number }, []>(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total;
          const before = {
            evidence: count("evidence"),
            signals: count("signals"),
            mappings: count("id_mappings"),
          };
          const second = importPackage({ packageDir, home });
          expect(second.inserted.evidence).toBe(0);
          expect(second.inserted.signals).toBe(0);
          expect(second.inserted.mapping).toBe(0);
          expect({
            evidence: count("evidence"),
            signals: count("signals"),
            mappings: count("id_mappings"),
          }).toEqual(before);
        } finally {
          db.close();
        }
      });
    } finally {
      removeDir(root);
    }
  });

  test("CLI export 輸出合法套件並以 0 結束", async () => {
    const fixture = buildV3Package();
    try {
      await withTempHome("import-export-cli", async (home, root) => {
        importPackage({ packageDir: fixture.packageDir, home });
        const outDir = join(root, "cli-export");
        const child = Bun.spawn(
          [process.execPath, "src/cli/index.ts", "export", "--out", outDir],
          {
            cwd: repoRoot,
            env: { ...process.env, SMILEWORK_HOME: home },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("work 3");
        expect(stderr).toBe("");
        expect(validatePackage(outDir).manifest.source.kind).toBe("smilework-db");
      });
    } finally {
      fixture.cleanup();
    }
  });
});


