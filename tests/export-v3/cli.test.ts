import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { validatePackage } from "../export-format/helpers/package";
import { copyFixture, makeTempDir, removeDir } from "./helpers/fixture";

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
  return { stdout, stderr, exitCode };
}

describe("export-v3 CLI", () => {
  test("--project 與 --out 會產生可驗證的套件", async () => {
    const project = copyFixture("v2-data");
    const parent = makeTempDir("cli");
    const out = join(parent, "package");
    try {
      const result = await runCli(["export-v3", "--project", project, "--out", out]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("匯出完成");
      expect(existsSync(join(out, "manifest.json"))).toBe(true);
      validatePackage(out);
    } finally {
      removeDir(project);
      removeDir(parent);
    }
  }, 30_000);

  test("缺少參數時顯示用法；repo 的 CLI 冒煙測試要求以 0 結束", async () => {
    const result = await runCli(["export-v3"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("用法");
    expect(result.stdout).toContain("--project");
  });
});
