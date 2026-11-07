import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { linkSkills } from "../../src/skill-link/link.ts";
import { scanSkillsRoot } from "../../src/skill-link/discover.ts";
import { withTempDir } from "../helpers/temp.ts";

interface Layout {
  readonly home: string;
  readonly project: string;
}

async function createLayout(root: string): Promise<Layout> {
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { home, project };
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

function globalLinkPathFor(home: string, name: string): string {
  return join(home, ".claude", "skills", name);
}

function projectLinkPathFor(project: string, name: string): string {
  return join(project, ".claude", "skills", name);
}

/** 用連結實際所在的目錄解析 target，link 根目錄本身是 symlink 時也正確。 */
async function assertSymlinkTo(linkPath: string, sourcePath: string): Promise<void> {
  const info = await lstat(linkPath);
  expect(info.isSymbolicLink()).toBe(true);
  const raw = await readlink(linkPath);
  const linkDir = await realpath(dirname(linkPath));
  expect(await realpath(resolve(linkDir, raw))).toBe(await realpath(sourcePath));
  expect((await stat(linkPath)).isDirectory()).toBe(true);
  expect(await Bun.file(join(linkPath, "SKILL.md")).text()).toContain(`name: ${basename(sourcePath)}`);
}

async function makeClaudeSkillsSymlink(home: string): Promise<string> {
  const central = join(home, "central-skills");
  await mkdir(central, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await symlink(central, join(home, ".claude", "skills"));
  return central;
}

describe("scanSkillsRoot", () => {
  test("只回傳含 SKILL.md 的資料夾，並支援指向資料夾的 symlink", async () => {
    await withTempDir("link-scan", async (root) => {
      const base = join(root, "home");
      await writeSkill(base, "alpha");
      await writeSkill(base, "beta");
      await mkdir(join(base, ".agents", "skills", "empty"), { recursive: true });
      await Bun.write(join(base, ".agents", "skills", "note.txt"), "not a skill");

      const library = join(root, "library", "gamma");
      await mkdir(library, { recursive: true });
      await Bun.write(join(library, "SKILL.md"), "---\nname: gamma\ndescription: linked skill\n---\n");
      await symlink(library, join(base, ".agents", "skills", "gamma"));

      const scan = await scanSkillsRoot(join(base, ".agents", "skills"));
      expect(scan.exists).toBe(true);
      expect(scan.skills).toEqual(["alpha", "beta", "gamma"]);

      const missing = await scanSkillsRoot(join(base, "nowhere"));
      expect(missing.exists).toBe(false);
      expect(missing.skills).toEqual([]);
    });
  });
});

describe("linkSkills", () => {
  test("為全域技能逐一建立指向來源的 symlink", async () => {
    await withTempDir("link-global", async (root) => {
      const { home } = await createLayout(root);
      const alpha = await writeSkill(home, "alpha");
      const beta = await writeSkill(home, "beta");

      const summary = await linkSkills({ home });
      expect(summary.globalLinkRoot).toBe(join(home, ".claude", "skills"));
      expect(summary.projectLinkRoot).toBeNull();
      expect(summary.overlaps).toEqual([]);
      expect(summary.results.map((result) => result.name)).toEqual(["alpha", "beta"]);
      expect(summary.results.every((result) => result.outcome === "created")).toBe(true);
      expect(summary.sources).toEqual([
        { layer: "global", root: join(home, ".agents", "skills"), exists: true, skillCount: 2 },
      ]);

      await assertSymlinkTo(globalLinkPathFor(home, "alpha"), alpha);
      await assertSymlinkTo(globalLinkPathFor(home, "beta"), beta);
    });
  });

  test("重跑時既有的正確 symlink 保持不變且不報錯", async () => {
    await withTempDir("link-rerun", async (root) => {
      const { home } = await createLayout(root);
      await writeSkill(home, "alpha");

      await linkSkills({ home });
      const linkPath = globalLinkPathFor(home, "alpha");
      const before = await lstat(linkPath);
      const rawBefore = await readlink(linkPath);

      const summary = await linkSkills({ home });
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]?.outcome).toBe("skipped");
      expect(summary.results[0]?.reason).toContain("已連結");

      const after = await lstat(linkPath);
      expect(await readlink(linkPath)).toBe(rawBefore);
      expect(after.ino).toBe(before.ino);
    });
  });

  test("目標是實體資料夾時回報衝突且不覆蓋", async () => {
    await withTempDir("link-real-dir", async (root) => {
      const { home } = await createLayout(root);
      await writeSkill(home, "alpha");
      const linkPath = globalLinkPathFor(home, "alpha");
      await mkdir(linkPath, { recursive: true });
      await Bun.write(join(linkPath, "keep.txt"), "keep me");

      const summary = await linkSkills({ home });
      expect(summary.results[0]?.outcome).toBe("conflict");
      expect(summary.results[0]?.reason).toContain("實體資料夾");
      expect((await lstat(linkPath)).isDirectory()).toBe(true);
      expect(await Bun.file(join(linkPath, "keep.txt")).text()).toBe("keep me");
      expect(existsSync(join(linkPath, "SKILL.md"))).toBe(false);
    });
  });

  test("目標是錯誤的 symlink 時回報衝突且不覆蓋", async () => {
    await withTempDir("link-wrong-symlink", async (root) => {
      const { home } = await createLayout(root);
      await writeSkill(home, "alpha");
      const linkPath = globalLinkPathFor(home, "alpha");
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(join(home, "elsewhere"), linkPath);

      const summary = await linkSkills({ home });
      expect(summary.results[0]?.outcome).toBe("conflict");
      expect(summary.results[0]?.reason).toContain("指向");
      expect(summary.results[0]?.reason).toContain("斷鏈");
      expect(await readlink(linkPath)).toBe(join(home, "elsewhere"));
    });
  });

  test("--dry-run 只列出計畫，不建立任何東西", async () => {
    await withTempDir("link-dry-run", async (root) => {
      const { home, project } = await createLayout(root);
      await writeSkill(home, "alpha");
      await writeSkill(project, "project-only");

      const summary = await linkSkills({ home, projectPath: project, dryRun: true });
      expect(summary.dryRun).toBe(true);
      expect(summary.results.map((result) => result.outcome)).toEqual(["created", "created"]);
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(existsSync(join(project, ".claude"))).toBe(false);
    });
  });

  test("link 根目錄是 symlink 時仍建立可解析的連結，重跑維持 skipped", async () => {
    await withTempDir("link-symlink-root", async (root) => {
      const { home } = await createLayout(root);
      const source = await writeSkill(home, "alpha");
      const central = await makeClaudeSkillsSymlink(home);
      const linkPath = globalLinkPathFor(home, "alpha");

      const first = await linkSkills({ home });
      expect(first.results[0]?.outcome).toBe("created");
      expect((await stat(linkPath)).isDirectory()).toBe(true);
      const raw = await readlink(linkPath);
      expect(await realpath(resolve(await realpath(central), raw))).toBe(await realpath(source));

      const second = await linkSkills({ home });
      expect(second.results[0]?.outcome).toBe("skipped");
      expect(await readlink(linkPath)).toBe(raw);
      expect((await stat(linkPath)).isDirectory()).toBe(true);
    });
  });

  test("經由 symlink 根目錄形成的斷鏈不會被當成已連結", async () => {
    await withTempDir("link-broken-under-symlink-root", async (root) => {
      const { home } = await createLayout(root);
      await writeSkill(home, "alpha");
      const central = await makeClaudeSkillsSymlink(home);
      const rawTarget = join("..", "..", ".agents", "skills", "alpha");
      await symlink(rawTarget, join(central, "alpha"));

      const linkPath = globalLinkPathFor(home, "alpha");
      await expect(stat(linkPath)).rejects.toThrow();

      const summary = await linkSkills({ home });
      expect(summary.results[0]?.outcome).toBe("conflict");
      expect(summary.results[0]?.reason).toContain("斷鏈");
      expect(await readlink(linkPath)).toBe(rawTarget);
    });
  });

  test("~/.claude 本身是 symlink 時仍建立可解析的連結", async () => {
    await withTempDir("link-claude-symlink", async (root) => {
      const { home } = await createLayout(root);
      const source = await writeSkill(home, "alpha");
      const central = join(home, "central-claude");
      await mkdir(central, { recursive: true });
      await symlink(central, join(home, ".claude"));

      const linkPath = globalLinkPathFor(home, "alpha");
      const first = await linkSkills({ home });
      expect(first.results[0]?.outcome).toBe("created");
      expect((await stat(linkPath)).isDirectory()).toBe(true);
      const raw = await readlink(linkPath);
      expect(await realpath(resolve(await realpath(join(central, "skills")), raw))).toBe(
        await realpath(source),
      );

      const second = await linkSkills({ home });
      expect(second.results[0]?.outcome).toBe("skipped");
      expect((await stat(linkPath)).isDirectory()).toBe(true);
    });
  });

  test("專案層技能連到專案自己的 .claude/skills", async () => {
    await withTempDir("link-project", async (root) => {
      const { home, project } = await createLayout(root);
      const globalOnly = await writeSkill(home, "global-only");
      const projectOnly = await writeSkill(project, "project-only");

      const summary = await linkSkills({ home, projectPath: project });
      expect(summary.globalLinkRoot).toBe(join(home, ".claude", "skills"));
      expect(summary.projectLinkRoot).toBe(join(project, ".claude", "skills"));
      expect(summary.sources).toContainEqual({
        layer: "project",
        root: join(project, ".agents", "skills"),
        exists: true,
        skillCount: 1,
      });
      expect(summary.results.map((result) => [result.name, result.layer])).toEqual([
        ["global-only", "global"],
        ["project-only", "project"],
      ]);
      expect(summary.results.every((result) => result.outcome === "created")).toBe(true);

      await assertSymlinkTo(globalLinkPathFor(home, "global-only"), globalOnly);
      await assertSymlinkTo(projectLinkPathFor(project, "project-only"), projectOnly);
      expect(existsSync(globalLinkPathFor(home, "project-only"))).toBe(false);
    });
  });

  test("跨層同名時各自建立，不互相覆蓋", async () => {
    await withTempDir("link-cross-layer", async (root) => {
      const { home, project } = await createLayout(root);
      const globalShared = await writeSkill(home, "shared", "global");
      const projectShared = await writeSkill(project, "shared", "project");

      const first = await linkSkills({ home });
      expect(first.results[0]?.outcome).toBe("created");
      await assertSymlinkTo(globalLinkPathFor(home, "shared"), globalShared);

      const second = await linkSkills({ home, projectPath: project });
      expect(second.overlaps).toEqual([
        {
          name: "shared",
          globalSourcePath: globalShared,
          projectSourcePath: projectShared,
          globalLinkPath: globalLinkPathFor(home, "shared"),
          projectLinkPath: projectLinkPathFor(project, "shared"),
        },
      ]);
      expect(
        second.results
          .filter((result) => result.name === "shared")
          .map((result) => [result.layer, result.outcome]),
      ).toEqual([
        ["global", "skipped"],
        ["project", "created"],
      ]);

      await assertSymlinkTo(globalLinkPathFor(home, "shared"), globalShared);
      await assertSymlinkTo(projectLinkPathFor(project, "shared"), projectShared);

      const third = await linkSkills({ home, projectPath: project });
      expect(third.results.every((result) => result.outcome === "skipped")).toBe(true);
      await assertSymlinkTo(globalLinkPathFor(home, "shared"), globalShared);
      await assertSymlinkTo(projectLinkPathFor(project, "shared"), projectShared);
    });
  });

  test("來源技能移除後，既有 symlink 不會被刪除", async () => {
    await withTempDir("link-orphan", async (root) => {
      const { home } = await createLayout(root);
      const source = await writeSkill(home, "alpha");
      await linkSkills({ home });
      const linkPath = globalLinkPathFor(home, "alpha");

      await rm(source, { recursive: true, force: true });

      const summary = await linkSkills({ home });
      expect(summary.results).toEqual([]);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(existsSync(linkPath)).toBe(false);
    });
  });

  test("來源技能本身是 symlink 時仍可建立", async () => {
    await withTempDir("link-chained", async (root) => {
      const { home } = await createLayout(root);
      const library = join(root, "library", "chained");
      await mkdir(library, { recursive: true });
      await Bun.write(join(library, "SKILL.md"), "---\nname: chained\ndescription: chained skill\n---\n");
      const sourceLink = join(home, ".agents", "skills", "chained");
      await mkdir(dirname(sourceLink), { recursive: true });
      await symlink(library, sourceLink);

      const summary = await linkSkills({ home });
      expect(summary.results[0]?.outcome).toBe("created");

      const linkPath = globalLinkPathFor(home, "chained");
      await assertSymlinkTo(linkPath, sourceLink);
      expect(await Bun.file(join(linkPath, "SKILL.md")).text()).toContain("name: chained");
    });
  });
});
