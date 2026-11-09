import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/index.ts";
import {
  preferRegisteredAncestor,
  registerProject,
  resolveProject,
  requireProject,
} from "../../src/project/index.ts";
import { projectIdFromPath } from "../../src/shared/hash.ts";
import { createGitRepo, createGitWorktree } from "../helpers/git.ts";
import { withTempDir, withTempHome } from "../helpers/temp.ts";

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

  test("非 git 目錄以正規化絕對路徑建立穩定的專案身分", async () => {
    await withTempDir("resolve-nongit", async (root) => {
      const plain = join(root, "plain");
      mkdirSync(plain);
      writeFileSync(join(plain, "file.txt"), "x", "utf8");
      const realPlain = realpathSync(plain);

      const resolved = resolveProject({ explicitPath: plain, env: {}, cwd: root });
      expect(resolved.projectId).toBe(projectIdFromPath(realPlain));
      expect(resolved.worktreePath).toBe(realPlain);
      expect(resolved.rootPath).toBe(realPlain);
      expect(resolved.commonDir).toBe(`path:${realPlain}`);

      const trailing = resolveProject({ explicitPath: `${plain}/`, env: {}, cwd: root });
      expect(trailing.projectId).toBe(resolved.projectId);

      const link = join(root, "link");
      symlinkSync(plain, link, "dir");
      const viaLink = resolveProject({ explicitPath: link, env: {}, cwd: root });
      expect(viaLink.projectId).toBe(resolved.projectId);

      expect(() => requireProject({ explicitPath: join(root, "other"), env: {}, cwd: root })).toThrow(
        expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
      );
    });
  });

  test("已登記的路徑專案會接回上層專案，子資料夾不產生新 projectId", async () => {
    await withTempHome("resolve-registered-ancestor", async (home) => {
      await withTempDir("resolve-ancestor-root", async (root) => {
        const projectRoot = join(root, "X");
        const nested = join(projectRoot, "plugins");
        mkdirSync(nested, { recursive: true });

        const db = openDatabase({ home });
        try {
          const parent = resolveProject({ explicitPath: projectRoot, env: {}, cwd: root });
          registerProject(db, parent);

          const child = resolveProject({ explicitPath: nested, env: {}, cwd: root });
          expect(child.projectId).not.toBe(parent.projectId);

          const preferred = preferRegisteredAncestor(db, child);
          expect(preferred.projectId).toBe(parent.projectId);
          expect(preferred.worktreePath).toBe(realpathSync(nested));
          expect(preferred.rootPath).toBe(realpathSync(projectRoot));

          registerProject(db, preferred);
          const rows = db
            .query<{ worktree_path: string }, [string]>(
              "SELECT worktree_path FROM project_worktrees WHERE project_id = ? ORDER BY worktree_path",
            )
            .all(parent.projectId);
          expect(rows.map((row) => row.worktree_path)).toEqual([
            realpathSync(projectRoot),
            realpathSync(nested),
          ]);
        } finally {
          db.close();
        }
      });
    });
  });

  test("檔案系統根目錄與系統暫存根目錄不建立路徑專案", () => {
    expect(() => resolveProject({ explicitPath: "/", env: {}, cwd: "/" })).toThrow(
      expect.objectContaining({ code: "PROJECT_REQUIRED" }),
    );
    expect(() => resolveProject({ explicitPath: tmpdir(), env: {}, cwd: "/" })).toThrow(
      expect.objectContaining({ code: "PROJECT_REQUIRED" }),
    );
  });

  test("有 .ultrawork/tasks.json 的非 git 目錄會接回舊 projectId", async () => {
    await withTempDir("resolve-legacy", async (root) => {
      const legacyRoot = join(root, "legacy");
      const nested = join(legacyRoot, "sub", "dir");
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(legacyRoot, ".ultrawork"), { recursive: true });
      writeFileSync(
        join(legacyRoot, ".ultrawork", "tasks.json"),
        JSON.stringify({ projectId: "legacy-project", projectPath: legacyRoot }),
        "utf8",
      );

      const fromRoot = resolveProject({ explicitPath: legacyRoot, env: {}, cwd: root });
      expect(fromRoot.projectId).toBe("legacy-project");
      expect(fromRoot.commonDir).toBe("import:legacy-project");
      expect(fromRoot.rootPath).toBe(realpathSync(legacyRoot));

      const fromNested = resolveProject({ explicitPath: nested, env: {}, cwd: root });
      expect(fromNested.projectId).toBe("legacy-project");
      expect(fromNested.worktreePath).toBe(realpathSync(nested));
    });
  });

  test("家目錄的 .ultrawork 不會把底下的新資料夾都認成同一個舊專案", async () => {
    await withTempDir("resolve-home-boundary", async (root) => {
      const home = join(root, "home");
      const fresh = join(home, "dev", "new-project");
      mkdirSync(fresh, { recursive: true });
      mkdirSync(join(home, ".ultrawork"), { recursive: true });
      writeFileSync(
        join(home, ".ultrawork", "tasks.json"),
        JSON.stringify({ projectId: "home-project" }),
        "utf8",
      );

      const fromHome = resolveProject({ explicitPath: home, env: { HOME: home }, cwd: root });
      expect(fromHome.projectId).toBe("home-project");

      const fromFresh = resolveProject({ explicitPath: fresh, env: { HOME: home }, cwd: root });
      expect(fromFresh.projectId).toBe(projectIdFromPath(realpathSync(fresh)));
    });
  });
});
