import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, requireProject } from "../../src/project/index.ts";
import { createGitRepo, createGitWorktree } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

function expectedProjectId(commonDir: string): string {
  return createHash("sha256").update(realpathSync(commonDir)).digest("hex").slice(0, 16);
}

describe("專案解析", () => {
  test("顯式參數優先於環境變數與 cwd", async () => {
    await withTempDir("resolve-explicit", async (root) => {
      const explicit = await createGitRepo(join(root, "explicit"));
      const other = await createGitRepo(join(root, "other"));

      const resolved = resolveProject({
        explicitPath: explicit,
        env: { SMILEWORK_PROJECT: other },
        cwd: other,
      });

      expect(resolved.rootPath).toBe(realpathSync(explicit));
      expect(resolved.projectId).toBe(expectedProjectId(join(explicit, ".git")));
    });
  });

  test("沒有工具參數時使用 SMILEWORK_PROJECT", async () => {
    await withTempDir("resolve-env", async (root) => {
      const fromEnv = await createGitRepo(join(root, "from-env"));
      const cwdRepo = await createGitRepo(join(root, "cwd-repo"));

      const resolved = resolveProject({
        env: { SMILEWORK_PROJECT: fromEnv },
        cwd: cwdRepo,
      });

      expect(resolved.rootPath).toBe(realpathSync(fromEnv));
    });
  });

  test("沒有參數與環境變數時使用程序 cwd", async () => {
    await withTempDir("resolve-cwd", async (root) => {
      const cwdRepo = await createGitRepo(join(root, "cwd-repo"));
      const nested = join(cwdRepo, "src", "deep");
      await Bun.write(join(nested, ".keep"), "");

      const resolved = resolveProject({ env: {}, cwd: nested });

      expect(resolved.rootPath).toBe(realpathSync(cwdRepo));
      expect(resolved.worktreePath).toBe(realpathSync(cwdRepo));
    });
  });

  test("相對的 SMILEWORK_PROJECT 依提供的 cwd 解析", async () => {
    await withTempDir("resolve-relative-env", async (root) => {
      const repo = await createGitRepo(join(root, "relative-repo"));

      const resolved = resolveProject({ env: { SMILEWORK_PROJECT: "relative-repo" }, cwd: root });

      expect(resolved.rootPath).toBe(realpathSync(repo));
    });
  });

  test("worktree 與主 repo 共用 projectId，但回傳各自的 worktree 路徑", async () => {
    await withTempDir("resolve-worktree", async (root) => {
      const repo = await createGitRepo(join(root, "main"));
      const worktree = await createGitWorktree(repo, join(root, "worktree"), "feature");

      const main = resolveProject({ explicitPath: repo, env: {}, cwd: root });
      const linked = resolveProject({ explicitPath: worktree, env: {}, cwd: root });

      expect(linked.projectId).toBe(main.projectId);
      expect(linked.worktreePath).toBe(realpathSync(worktree));
      expect(linked.commonDir).toBe(main.commonDir);
      expect(linked.worktreePath).not.toBe(main.worktreePath);
      expect(linked.rootPath).toBe(realpathSync(repo));
      expect(main.rootPath).toBe(realpathSync(repo));
    });
  });

  test("沒有傳 env 時使用 process.env 的 SMILEWORK_PROJECT", async () => {
    await withTempDir("resolve-process-env", async (root) => {
      const repo = await createGitRepo(join(root, "from-process-env"));
      const plain = join(root, "plain");
      await Bun.write(join(plain, ".keep"), "");
      const previous = process.env.SMILEWORK_PROJECT;
      process.env.SMILEWORK_PROJECT = repo;
      try {
        const resolved = resolveProject({ cwd: plain });
        expect(resolved.projectId).toBe(expectedProjectId(join(repo, ".git")));
        expect(resolved.worktreePath).toBe(realpathSync(repo));
      } finally {
        if (previous === undefined) delete process.env.SMILEWORK_PROJECT;
        else process.env.SMILEWORK_PROJECT = previous;
      }
    });
  });

  test("非 git 目錄回 NOT_GIT_REPOSITORY，且寫入要求明確失敗", async () => {
    await withTempDir("resolve-nongit", async (root) => {
      const plain = join(root, "plain");
      await Bun.write(join(plain, "file.txt"), "x");

      expect(() => resolveProject({ explicitPath: plain, env: {}, cwd: root })).toThrow(
        expect.objectContaining({ code: "NOT_GIT_REPOSITORY" }),
      );

      expect(() => requireProject({ explicitPath: plain, env: {}, cwd: root })).toThrow(
        expect.objectContaining({ code: "NOT_GIT_REPOSITORY" }),
      );
    });
  });

  test("完全無法解析時回 PROJECT_REQUIRED 並附下一步", async () => {
    await withTempDir("resolve-required", async (root) => {
      let error: unknown;
      try {
        requireProject({ env: {}, cwd: root });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({ code: "PROJECT_REQUIRED" });
      expect((error as { nextAction?: string }).nextAction).toContain("SMILEWORK_PROJECT");
    });
  });
});
