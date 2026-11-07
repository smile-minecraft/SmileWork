import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withTempDir } from "../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: readonly string[], home: string): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function writeSkill(base: string, name: string, marker = name): Promise<string> {
  const skillPath = join(base, ".agents", "skills", name);
  await mkdir(skillPath, { recursive: true });
  await Bun.write(
    join(skillPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker} skill\n---\n\n# ${marker}\n`,
  );
  return skillPath;
}

describe("smilework link CLI", () => {
  test("--dry-run 列出計畫且不建立 symlink", async () => {
    await withTempDir("link-cli-dry", async (root) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      await writeSkill(home, "alpha");

      const result = await runCli(["link", "--dry-run"], home);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dry-run");
      expect(result.stdout).toContain("將建立");
      expect(result.stdout).toContain(join(home, ".claude", "skills", "alpha"));
      expect(result.stdout).toContain(join(home, ".agents", "skills", "alpha"));
      expect(result.stdout).toContain("摘要：將建立 1、略過 0、衝突 0");
      expect(existsSync(join(home, ".claude"))).toBe(false);
    });
  }, 30_000);

  test("建立 symlink 並逐一列出路徑", async () => {
    await withTempDir("link-cli-create", async (root) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      const source = await writeSkill(home, "alpha");

      const result = await runCli(["link"], home);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("建立");
      expect(result.stdout).toContain(join(home, ".claude", "skills", "alpha"));
      expect(result.stdout).toContain(source);
      expect(result.stdout).toContain("建立 1、略過 0、衝突 0");

      const linkPath = join(home, ".claude", "skills", "alpha");
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(resolve(dirname(linkPath), await readlink(linkPath))).toBe(source);
    });
  }, 30_000);

  test("專案層技能用 --project 指定，連到專案的 .claude/skills", async () => {
    await withTempDir("link-cli-project", async (root) => {
      const home = join(root, "home");
      const project = join(root, "project");
      await mkdir(home, { recursive: true });
      await mkdir(project, { recursive: true });
      const source = await writeSkill(project, "project-skill");

      const result = await runCli(["link", "--project", project], home);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(source);
      const linkPath = join(project, ".claude", "skills", "project-skill");
      expect(result.stdout).toContain(linkPath);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await realpath(resolve(dirname(linkPath), await readlink(linkPath)))).toBe(
        await realpath(source),
      );
      expect(existsSync(join(home, ".claude", "skills", "project-skill"))).toBe(false);
    });
  }, 30_000);

  test("link 根目錄是 symlink 時仍回報成功且連結可解析", async () => {
    await withTempDir("link-cli-symlink-root", async (root) => {
      const home = join(root, "home");
      const central = join(home, "central-skills");
      await mkdir(join(home, ".agents", "skills", "alpha"), { recursive: true });
      await Bun.write(
        join(home, ".agents", "skills", "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: alpha skill\n---\n",
      );
      await mkdir(central, { recursive: true });
      await mkdir(join(home, ".claude"), { recursive: true });
      await symlink(central, join(home, ".claude", "skills"));

      const result = await runCli(["link"], home);
      expect(result.exitCode).toBe(0);
      const linkPath = join(home, ".claude", "skills", "alpha");
      expect(result.stdout).toContain(linkPath);
      expect((await stat(linkPath)).isDirectory()).toBe(true);
    });
  }, 30_000);

  test("跨層同名時列出兩個各自獨立的目標", async () => {
    await withTempDir("link-cli-cross-layer", async (root) => {
      const home = join(root, "home");
      const project = join(root, "project");
      await mkdir(home, { recursive: true });
      await mkdir(project, { recursive: true });
      const globalSource = await writeSkill(home, "shared", "global");
      const projectSource = await writeSkill(project, "shared", "project");

      const result = await runCli(["link", "--project", project], home);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("同名技能");
      expect(result.stdout).toContain("各自");
      const globalLink = join(home, ".claude", "skills", "shared");
      const projectLink = join(project, ".claude", "skills", "shared");
      expect(result.stdout).toContain(globalLink);
      expect(result.stdout).toContain(projectLink);

      expect(await realpath(resolve(dirname(globalLink), await readlink(globalLink)))).toBe(
        await realpath(globalSource),
      );
      expect(await realpath(resolve(dirname(projectLink), await readlink(projectLink)))).toBe(
        await realpath(projectSource),
      );
    });
  }, 30_000);

  test("實體資料夾衝突時回報原因並以非零結束", async () => {
    await withTempDir("link-cli-conflict", async (root) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      await writeSkill(home, "alpha");
      const linkPath = join(home, ".claude", "skills", "alpha");
      await mkdir(linkPath, { recursive: true });
      await Bun.write(join(linkPath, "keep.txt"), "keep me");

      const result = await runCli(["link"], home);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("衝突");
      expect(result.stdout).toContain(linkPath);
      expect(result.stdout).toContain("實體資料夾");
      expect(await Bun.file(join(linkPath, "keep.txt")).text()).toBe("keep me");
    });
  }, 30_000);

  test("錯誤的 symlink 衝突時列出目前指向", async () => {
    await withTempDir("link-cli-wrong", async (root) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      await writeSkill(home, "alpha");
      const linkPath = join(home, ".claude", "skills", "alpha");
      await mkdir(dirname(linkPath), { recursive: true });
      const elsewhere = join(root, "elsewhere");
      await symlink(elsewhere, linkPath);

      const result = await runCli(["link"], home);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("衝突");
      expect(result.stdout).toContain(elsewhere);
      expect(resolve(dirname(linkPath), await readlink(linkPath))).toBe(elsewhere);
    });
  }, 30_000);

  test("--project 指向不存在路徑時回錯誤", async () => {
    await withTempDir("link-cli-missing-project", async (root) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });

      const result = await runCli(["link", "--project", join(root, "missing")], home);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("專案路徑不存在");
    });
  }, 30_000);

  test("不支援的參數回錯誤與用法", async () => {
    await withTempDir("link-cli-unknown", async (root) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });

      const result = await runCli(["link", "--nope"], home);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--nope");
      expect(result.stderr).toContain("用法");
    });
  }, 30_000);
});
