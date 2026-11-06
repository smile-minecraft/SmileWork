import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ExportV3Error } from "../../src/export/v3/errors.ts";
import { exportV3 } from "../../src/export/v3/index.ts";
import { validatePackage } from "../export-format/helpers/package";
import {
  copyFixtureProject,
  hashTree,
  makeTempDir,
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

interface TaskInput {
  state: string;
  dependsOn?: string[];
  owner?: string;
  title?: string;
  extra?: Record<string, unknown>;
}

interface PlanInput {
  state: string;
  owner?: string;
  title?: string;
  taskIds?: string[];
  finishedTaskIds?: string[];
  completionTombstones?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

function writeProject(
  root: string,
  tasks: Record<string, TaskInput>,
  plans: Record<string, PlanInput>,
): string {
  const ultrawork = join(root, ".ultrawork");
  mkdirSync(ultrawork, { recursive: true });
  const taskRecords: Record<string, unknown> = {};
  for (const [taskId, input] of Object.entries(tasks)) {
    taskRecords[taskId] = {
      taskId,
      projectId: "tombstone-project",
      projectPath: "/fixture-placeholder/project",
      title: input.title ?? `Task ${taskId}`,
      state: input.state,
      owner: input.owner ?? "build",
      priority: "medium",
      updatedAt: "2026-10-07T18:01:27.000Z",
      history: [],
      ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      ...input.extra,
    };
  }
  writeFileSync(
    join(ultrawork, "tasks.json"),
    JSON.stringify({
      version: "4.0",
      projectId: "tombstone-project",
      projectPath: "/fixture-placeholder/project",
      activeTaskIds: [],
      taskCursor: null,
      tasks: taskRecords,
    }),
  );

  const planRecords: Record<string, unknown> = {};
  for (const [planId, input] of Object.entries(plans)) {
    planRecords[planId] = {
      planId,
      projectId: "tombstone-project",
      projectPath: "/fixture-placeholder/project",
      title: input.title ?? `Plan ${planId}`,
      state: input.state,
      owner: input.owner ?? "arch",
      priority: "medium",
      createdAt: "2026-10-07T18:01:27.000Z",
      updatedAt: "2026-10-07T18:01:27.000Z",
      taskIds: input.taskIds ?? [],
      finishedTaskIds: input.finishedTaskIds ?? [],
      dependencyGraph: { nodes: [], edges: [] },
      history: [],
      ...(input.completionTombstones === undefined
        ? {}
        : { completionTombstones: input.completionTombstones }),
      ...input.extra,
    };
  }
  writeFileSync(
    join(ultrawork, "plans.json"),
    JSON.stringify({
      version: "1.0",
      projectId: "tombstone-project",
      projectPath: "/fixture-placeholder/project",
      activePlanIds: [],
      planCursor: null,
      plans: planRecords,
    }),
  );
  return root;
}

function catchExportError(run: () => unknown): ExportV3Error {
  try {
    run();
  } catch (error) {
    if (error instanceof ExportV3Error) return error;
    throw error;
  }
  throw new Error("預期匯出失敗，但沒有拋出錯誤");
}

function packageWork(root: string): Map<string, Record<string, unknown>> {
  return new Map(
    readJsonLines(join(root, "work.jsonl")).map((record) => [String(record.workId), record]),
  );
}

function danglingDependencies(work: Map<string, Record<string, unknown>>): string[] {
  const dangling: string[] = [];
  for (const [workId, record] of work) {
    const dependsOn = record.dependsOn;
    if (!Array.isArray(dependsOn)) continue;
    for (const dependency of dependsOn) {
      if (!work.has(String(dependency))) dangling.push(`${workId} -> ${String(dependency)}`);
    }
  }
  return dangling;
}

describe("completionTombstones 與真實資料形狀", () => {
  test("只存在於 tombstone 的依賴會變成可解析的最小 work", () => {
    const root = tempDirectory();
    writeProject(
      root,
      {
        "t-dependent": {
          state: "PLANNED",
          dependsOn: ["t-pruned"],
          extra: {
            parentTaskId: "t-parent",
            subTaskIds: ["t-child"],
            blockedBy: ["t-blocker"],
            planStep: 2,
          },
        },
      },
      {
        "p-main": {
          state: "IN_PROGRESS",
          owner: "—",
          taskIds: ["t-dependent"],
          finishedTaskIds: ["t-pruned"],
          completionTombstones: {
            "t-pruned": {
              state: "COMPLETED",
              finishedAt: "2026-10-07T18:01:27.000Z",
              risk: "high",
            },
          },
        },
      },
    );
    const before = hashTree(join(root, ".ultrawork"));
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: root, out });
    validatePackage(out);
    expect(hashTree(join(root, ".ultrawork"))).toEqual(before);

    const work = packageWork(out);
    expect(danglingDependencies(work)).toEqual([]);
    expect(work.get("t-pruned")).toMatchObject({
      workId: "t-pruned",
      kind: "task",
      title: "t-pruned",
      status: "done",
      resolution: "completed",
      owner: "unknown",
      priority: "medium",
      planId: "p-main",
    });
    expect(work.get("t-dependent")?.dependsOn).toEqual(["t-pruned"]);
    expect(work.get("p-main")?.owner).toBe("unknown");

    expect(result.warnings).toContain("LEGACY_TITLE_FALLBACK: t-pruned");
    expect(result.warnings).toContain("LEGACY_OWNER_FALLBACK: p-main");
    expect(result.warnings).toContain("RAW_ONLY_PLAN_FIELD: p-main.completionTombstones");
    expect(result.warnings).toContain("RAW_ONLY_PLAN_FIELD: p-main.taskIds");
    expect(result.warnings).toContain("RAW_ONLY_TASK_FIELD: t-dependent.parentTaskId");
    expect(result.warnings).toContain("RAW_ONLY_TASK_FIELD: t-dependent.subTaskIds");
    expect(result.warnings).toContain("RAW_ONLY_TASK_FIELD: t-dependent.blockedBy");
    expect(result.warnings).toContain("RAW_ONLY_TASK_FIELD: t-dependent.planStep");

    const mapping = readJsonLines(join(out, "mapping.jsonl"));
    const tombstoneMapping = mapping.find(
      (record) =>
        record.entity === "work" &&
        record.sourceId === "t-pruned" &&
        record.sourceRecord === "/plans/p-main/completionTombstones/t-pruned",
    );
    expect(tombstoneMapping).toBeDefined();
    expect(tombstoneMapping?.targetId).toBe("t-pruned");
    expect(tombstoneMapping?.sourceRef).toBe("raw/project/plans.json");
  });

  test("找不到 tombstone 的依賴會移除並留下 warning 與 signal", () => {
    const root = tempDirectory();
    writeProject(
      root,
      {
        "t-needs-missing": {
          state: "PLANNED",
          dependsOn: ["t-nowhere"],
        },
      },
      {},
    );
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: root, out });
    validatePackage(out);
    const work = packageWork(out);
    expect(danglingDependencies(work)).toEqual([]);
    expect(work.get("t-needs-missing")?.dependsOn).toBeUndefined();
    expect(result.warnings).toContain("UNRESOLVED_DEPENDENCY: t-needs-missing -> t-nowhere");

    const signals = readJsonLines(join(out, "signals.jsonl"));
    const signal = signals.find((record) => record.code === "UNRESOLVED_DEPENDENCY");
    expect(signal).toBeDefined();
    expect(signal?.details).toEqual({ dependencyId: "t-nowhere" });
    expect(signal?.workId).toBe("t-needs-missing");
  });

  test("--out 經 symlink 指進來源時拒絕", () => {
    const project = copyFixtureProject();
    const before = hashTree(project.ultrawork);
    const linkParent = tempDirectory();
    const link = join(linkParent, "source-link");
    symlinkSync(project.ultrawork, link, "dir");
    const out = join(link, "export");

    const error = catchExportError(() => exportV3({ project: project.root, out }));
    expect(error.code).toBe("OUTPUT_INSIDE_SOURCE");
    expect(existsSync(join(project.ultrawork, "export"))).toBe(false);
    expect(hashTree(project.ultrawork)).toEqual(before);
  });
});
