import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exportV3 } from "../../src/export/v3/index.ts";
import { validatePackage } from "../export-format/helpers/package";
import {
  copyFixtureProject,
  makeTempDir,
  readJson,
  readJsonLines,
} from "./helpers/fixtures";

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = makeTempDir();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface SyntheticTask {
  state: string;
  title?: string;
  extra?: Record<string, unknown>;
}

function writeRegistryProject(tasks: Record<string, SyntheticTask>): string {
  const root = tempDirectory();
  const ultrawork = join(root, ".ultrawork");
  mkdirSync(ultrawork, { recursive: true });
  const records: Record<string, unknown> = {};
  for (const [taskId, task] of Object.entries(tasks)) {
    records[taskId] = {
      taskId,
      projectId: "matrix",
      projectPath: "/fixture-placeholder/project",
      ...(task.title === undefined ? {} : { title: task.title }),
      state: task.state,
      owner: "fixture-owner",
      priority: "medium",
      history: [],
      ...task.extra,
    };
  }
  writeFileSync(
    join(ultrawork, "tasks.json"),
    JSON.stringify({
      version: "4.0",
      projectId: "matrix",
      projectPath: "/fixture-placeholder/project",
      activeTaskIds: [],
      taskCursor: null,
      tasks: records,
    }),
  );
  writeFileSync(
    join(ultrawork, "plans.json"),
    JSON.stringify({
      version: "1.0",
      projectId: "matrix",
      projectPath: "/fixture-placeholder/project",
      activePlanIds: [],
      planCursor: null,
      plans: {},
    }),
  );
  return root;
}

describe("狀態與欄位對應", () => {
  test("舊狀態逐項對應到 v1 狀態與 resolution", () => {
    const root = writeRegistryProject({
      "t-new": { state: "NEW" },
      "t-draft": { state: "DRAFT" },
      "t-clarifying": { state: "CLARIFYING" },
      "t-planned": { state: "PLANNED" },
      "t-progress": { state: "IN_PROGRESS" },
      "t-active": { state: "ACTIVE" },
      "t-blocked": { state: "BLOCKED" },
      "t-reviewing": { state: "REVIEWING" },
      "t-archiving": { state: "ARCHIVING" },
      "t-completed": { state: "COMPLETED" },
      "t-done": { state: "DONE" },
      "t-failed": { state: "FAILED" },
      "t-cancelled": { state: "CANCELLED" },
    });
    const out = join(tempDirectory(), "out");

    exportV3({ project: root, out });
    validatePackage(out);
    const work = new Map(
      readJsonLines(join(out, "work.jsonl")).map((record) => [record.workId, record]),
    );

    const expectations: Array<[string, string, string | undefined]> = [
      ["t-new", "open", undefined],
      ["t-draft", "open", undefined],
      ["t-clarifying", "open", undefined],
      ["t-planned", "open", undefined],
      ["t-progress", "in_progress", undefined],
      ["t-active", "in_progress", undefined],
      ["t-blocked", "blocked", undefined],
      ["t-reviewing", "review", undefined],
      ["t-archiving", "review", undefined],
      ["t-completed", "done", "completed"],
      ["t-done", "done", "completed"],
      ["t-failed", "done", "failed"],
      ["t-cancelled", "cancelled", "abandoned"],
    ];
    for (const [taskId, status, resolution] of expectations) {
      expect(work.get(taskId)?.status).toBe(status);
      expect(work.get(taskId)?.resolution).toBe(resolution);
    }
  });

  test("缺少 title 時用 workId 並記警告", () => {
    const root = writeRegistryProject({
      "t-untitled": { state: "PLANNED" },
    });
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: root, out });
    const work = readJsonLines(join(out, "work.jsonl"));

    expect(work).toHaveLength(1);
    expect(work[0]?.title).toBe("t-untitled");
    expect(result.warnings).toContain("LEGACY_TITLE_FALLBACK: t-untitled");
  });

  test("review 與 acceptanceResults 會去掉來源時間欄位並保留對齊", () => {
    const root = writeRegistryProject({
      "t-reviewed": {
        state: "COMPLETED",
        title: "已審查任務",
        extra: {
          review: {
            verdict: "approve",
            reviewer: "momus",
            reviewedAt: "2026-10-07T18:01:27.000Z",
            reviewedStateUpdatedAt: "2026-10-07T18:01:27.000Z",
            note: "審查通過",
            reworkedAfterReview: false,
          },
          acceptanceCriteria: ["條件一", "條件二"],
          acceptanceResults: {
            recordedAt: "2026-10-07T18:01:27.000Z",
            recordedBy: "build",
            items: [
              { criterion: "條件一", met: true, evidence: "證據一" },
              { criterion: "條件二", met: true },
            ],
          },
        },
      },
    });
    const out = join(tempDirectory(), "out");

    exportV3({ project: root, out });
    validatePackage(out);
    const work = readJsonLines(join(out, "work.jsonl"))[0]!;

    expect(work.review).toEqual({
      verdict: "approve",
      reviewer: "momus",
      note: "審查通過",
      reworkedAfterReview: false,
    });
    expect(work.acceptance).toEqual(["條件一", "條件二"]);
    expect(work.acceptanceResults).toEqual({
      recordedBy: "build",
      items: [
        { criterion: "條件一", met: true, evidence: "證據一" },
        { criterion: "條件二", met: true },
      ],
    });
    const text = readFileSync(join(out, "work.jsonl"), "utf8");
    expect(text).not.toContain("reviewedAt");
    expect(text).not.toContain("recordedAt");
  });

  test("acceptanceResults 與 acceptance 不對齊時整組省略並記警告", () => {
    const root = writeRegistryProject({
      "t-mismatch": {
        state: "COMPLETED",
        title: "不對齊任務",
        extra: {
          acceptanceCriteria: ["條件一"],
          acceptanceResults: {
            recordedBy: "build",
            items: [{ criterion: "別的條件", met: true }],
          },
        },
      },
    });
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: root, out });
    validatePackage(out);
    const work = readJsonLines(join(out, "work.jsonl"))[0]!;

    expect(work.acceptance).toEqual(["條件一"]);
    expect(work.acceptanceResults).toBeUndefined();
    expect(result.warnings).toContain("LEGACY_ACCEPTANCE_MISMATCH: t-mismatch");
  });
});

describe("signal 與 audit 對應", () => {
  test("memory log 的 note、consumed、dismissed 轉成 signals", () => {
    const project = copyFixtureProject();
    const logPath = join(project.ultrawork, "memory", "log.jsonl");
    const existing = readFileSync(logPath, "utf8");
    writeFileSync(
      logPath,
      `${existing}${[
        JSON.stringify({
          kind: "note",
          topic: "fixture-topic",
          content: "請記得檢查匯出格式",
          agent: "build",
          taskId: "t-fixture-active",
          seq: 2,
        }),
        JSON.stringify({ kind: "note-consumed", topic: "fixture-topic", noteSeq: 2, seq: 3 }),
        JSON.stringify({
          kind: "note-dismissed",
          topic: "fixture-topic",
          noteSeq: 2,
          reason: "已不需要",
          seq: 4,
        }),
        JSON.stringify({ kind: "write", topic: "fixture-topic", seq: 5 }),
      ].join("\n")}\n`,
    );
    const out = join(tempDirectory(), "out");

    exportV3({ project: project.root, out });
    validatePackage(out);
    const signals = readJsonLines(join(out, "signals.jsonl"));

    expect(signals).toHaveLength(3);
    expect(signals.map((signal) => signal.code)).toEqual([
      "LEGACY_NOTE",
      "LEGACY_NOTE_CONSUMED",
      "LEGACY_NOTE_DISMISSED",
    ]);
    expect(signals[0]?.message).toBe("請記得檢查匯出格式");
    expect(signals[0]?.workId).toBe("t-fixture-active");
    expect(signals[1]?.message).toBe("舊版記憶筆記已採用");
    expect(signals[2]?.message).toBe("已不需要");
    expect(signals[0]?.details).toEqual({
      legacyKind: "note",
      topic: "fixture-topic",
      agent: "build",
    });

    const mapping = readJsonLines(join(out, "mapping.jsonl"));
    expect(mapping.filter((record) => record.entity === "signal")).toHaveLength(3);
  });

  test("audit.jsonl 的 review、terminal、risk 與未知事件都有對應", () => {
    const project = copyFixtureProject();
    writeFileSync(
      join(project.ultrawork, "audit.jsonl"),
      `${[
        JSON.stringify({
          at: "2026-10-07T18:01:27.300Z",
          event: "review",
          taskId: "t-fixture-active",
          projectId: "project",
          actor: "momus",
          verdict: "approve",
          reviewer: "momus",
          note: "審查通過",
        }),
        JSON.stringify({
          at: "2026-10-07T18:01:27.301Z",
          event: "terminal",
          taskId: "t-fixture-done",
          projectId: "project",
          actor: "build",
          finalState: "CANCELLED",
          risk: "high",
        }),
        JSON.stringify({
          at: "2026-10-07T18:01:27.302Z",
          event: "risk-declared",
          taskId: "t-fixture-active",
          projectId: "project",
          actor: "build",
          phase: "create",
          risk: "high",
        }),
        JSON.stringify({
          at: "2026-10-07T18:01:27.303Z",
          event: "future-event",
          taskId: "t-fixture-active",
          projectId: "project",
        }),
      ].join("\n")}\n`,
    );
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: project.root, out });
    validatePackage(out);
    const events = readJsonLines(join(out, "events.jsonl"));

    expect(events).toHaveLength(12);
    expect(events.filter((event) => event.kind === "reviewed")).toHaveLength(1);
    const terminal = events.find(
      (event) => event.kind === "status_changed" && event.workId === "t-fixture-done",
    );
    expect(terminal?.toStatus).toBe("cancelled");
    expect(terminal?.resolution).toBe("abandoned");
    expect(result.warnings).toContain("UNMAPPED_AUDIT_EVENT: future-event");
  });
});

describe("無法對應的資料", () => {
  test("未知狀態、未知欄位與未知檔案都只記警告，不中斷整包", () => {
    const project = copyFixtureProject();
    const tasksPath = join(project.ultrawork, "tasks.json");
    const registry = readJson(tasksPath);
    const tasks = registry.tasks as Record<string, Record<string, unknown>>;
    tasks["t-fixture-active"]!.futureField = "未來資料";
    tasks["t-fixture-weird"] = {
      taskId: "t-fixture-weird",
      title: "未知狀態任務",
      state: "WEIRD",
      owner: "fixture-owner",
      priority: "medium",
      history: [],
    };
    writeFileSync(tasksPath, JSON.stringify(registry, null, 2));
    mkdirSync(join(project.ultrawork, "notes"), { recursive: true });
    writeFileSync(join(project.ultrawork, "notes", "unknown.bin"), new Uint8Array([0, 1, 2, 255]));

    const out = join(tempDirectory(), "out");
    const result = exportV3({ project: project.root, out });
    validatePackage(out);

    expect(result.warnings).toContain("UNMAPPED_STATUS: t-fixture-weird (WEIRD)");
    expect(result.warnings).toContain("UNMAPPED_TASK_FIELD: t-fixture-active.futureField");
    expect(result.warnings).toContain("UNMAPPED_SOURCE_FILE: project/notes/unknown.bin");
    const work = readJsonLines(join(out, "work.jsonl"));
    expect(work.map((record) => record.workId)).not.toContain("t-fixture-weird");
    expect(work).toHaveLength(3);
    expect(
      readFileSync(join(out, "raw/project/notes/unknown.bin")),
    ).toEqual(readFileSync(join(project.ultrawork, "notes", "unknown.bin")));
  });
});
