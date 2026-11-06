import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ExportV3Error } from "../../src/export/v3/errors.ts";
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

function catchExportError(run: () => unknown): ExportV3Error {
  try {
    run();
  } catch (error) {
    if (error instanceof ExportV3Error) return error;
    throw error;
  }
  throw new Error("預期匯出失敗，但沒有拋出錯誤");
}

const repoRoot = join(import.meta.dir, "..", "..");

async function runCli(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, output: stdout + stderr, exitCode };
}

describe("必要來源與錯誤", () => {
  test("缺少 tasks.json 時回報清楚錯誤，且不建立半套輸出", () => {
    const root = tempDirectory();
    const ultrawork = join(root, ".ultrawork");
    mkdirSync(join(ultrawork, "memory", "topics"), { recursive: true });
    writeFileSync(join(ultrawork, "memory", "topics", "orphan.md"), "---\ntitle: x\n---\n");
    const out = join(tempDirectory(), "out");

    const error = catchExportError(() => exportV3({ project: root, out }));
    expect(error.code).toBe("TASKS_REGISTRY_MISSING");
    expect(error.message).toContain("tasks.json");
    expect(existsSync(out)).toBe(false);
  });

  test("tasks.json 不是合法 JSON 時不建立輸出", () => {
    const root = tempDirectory();
    const ultrawork = join(root, ".ultrawork");
    mkdirSync(ultrawork, { recursive: true });
    writeFileSync(join(ultrawork, "tasks.json"), "{ not json");
    const out = join(tempDirectory(), "out");

    const error = catchExportError(() => exportV3({ project: root, out }));
    expect(error.code).toBe("TASKS_REGISTRY_INVALID");
    expect(existsSync(out)).toBe(false);
  });

  test("找不到可辨識的來源時回報 NOT_ULTRAWORK_SOURCE", () => {
    const root = tempDirectory();
    const error = catchExportError(() =>
      exportV3({ project: root, out: join(tempDirectory(), "out") }),
    );
    expect(error.code).toBe("NOT_ULTRAWORK_SOURCE");
  });

  test("--project 直接指向 .ultrawork 也可以", () => {
    const project = copyFixtureProject();
    const out = join(tempDirectory(), "out");

    exportV3({ project: project.ultrawork, out });
    validatePackage(out);
    expect(readJson(join(out, "manifest.json")).source).toMatchObject({ projectId: "project" });
  });

  test("plans.json 損壞時記警告，tasks 仍可匯出", () => {
    const project = copyFixtureProject();
    writeFileSync(join(project.ultrawork, "plans.json"), "{ broken");
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: project.root, out });
    validatePackage(out);
    const work = readJsonLines(join(out, "work.jsonl"));
    expect(work.filter((record) => record.kind === "plan")).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.startsWith("INVALID_PLANS_REGISTRY"))).toBe(true);
  });

  test("全域來源不存在時回報 GLOBAL_SOURCE_NOT_FOUND", () => {
    const project = copyFixtureProject();
    const error = catchExportError(() =>
      exportV3({
        project: project.root,
        global: join(tempDirectory(), "missing-global"),
        out: join(tempDirectory(), "out"),
      }),
    );
    expect(error.code).toBe("GLOBAL_SOURCE_NOT_FOUND");
  });
});

describe("輸出資料夾", () => {
  test("非空輸出資料夾要 --force 才能取代", () => {
    const project = copyFixtureProject();
    const out = join(tempDirectory(), "out");
    exportV3({ project: project.root, out });

    const error = catchExportError(() => exportV3({ project: project.root, out }));
    expect(error.code).toBe("OUTPUT_NOT_EMPTY");

    exportV3({ project: project.root, out, force: true });
    validatePackage(out);
  });

  test("輸出資料夾不能在來源內", () => {
    const project = copyFixtureProject();
    const out = join(project.ultrawork, "export");

    const error = catchExportError(() => exportV3({ project: project.root, out }));
    expect(error.code).toBe("OUTPUT_INSIDE_SOURCE");
    expect(existsSync(out)).toBe(false);
  });

  test("空輸出資料夾可以直接使用", () => {
    const project = copyFixtureProject();
    const out = join(tempDirectory(), "out");
    mkdirSync(out);

    exportV3({ project: project.root, out });
    validatePackage(out);
  });
});

describe("CLI", () => {
  test("export-v3 可以用參數完成匯出", async () => {
    const project = copyFixtureProject();
    const out = join(tempDirectory(), "out");
    const result = await runCli(["export-v3", "--project", project.root, "--out", out]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`匯出完成：${out}`);
    validatePackage(out);
  });

  test("不帶參數時顯示說明並以 0 結束", async () => {
    const result = await runCli(["export-v3"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("用法：smilework export-v3");
    expect(result.output).toContain("尚未實作");
  });

  test("缺少必要參數時以非 0 結束", async () => {
    const result = await runCli(["export-v3", "--project", "somewhere"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("缺少 --out");
  });

  test("未知參數時以非 0 結束", async () => {
    const result = await runCli(["export-v3", "--nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知的參數");
  });
});
