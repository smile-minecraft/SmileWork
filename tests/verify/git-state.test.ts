import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGitWorkspaceState } from "../../src/verify/git-state.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失敗：${result.stderr}`);
}

describe("captureGitWorkspaceState", () => {
  test("不是 git repo 或路徑不存在時回 isGitRepo false 與 null 欄位", async () => {
    await withTempDir("git-state-plain", async (root) => {
      const expected = { isGitRepo: false, gitHead: null, workingTreeClean: null, treeFingerprint: null };
      expect(captureGitWorkspaceState(root)).toEqual(expected);
      expect(captureGitWorkspaceState(join(root, "missing"))).toEqual(expected);
    });
  });

  test("指紋是確定的，任何追蹤、暫存或未追蹤檔案的改動都會改變它", async () => {
    await withTempDir("git-state-repo", async (root) => {
      const repo = await createGitRepo(join(root, "repo"));
      const clean = captureGitWorkspaceState(repo);
      expect(clean.isGitRepo).toBe(true);
      expect(clean.gitHead).toMatch(/^[0-9a-f]{40}$/);
      expect(clean.workingTreeClean).toBe(true);
      expect(clean.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(captureGitWorkspaceState(repo)).toEqual(clean);

      const seen = new Set([clean.treeFingerprint]);
      const record = (): string => {
        const state = captureGitWorkspaceState(repo);
        expect(state.workingTreeClean).toBe(false);
        expect(seen.has(state.treeFingerprint)).toBe(false);
        seen.add(state.treeFingerprint);
        return state.treeFingerprint!;
      };

      writeFileSync(join(repo, "README.md"), "# changed\n", "utf8");
      record();
      writeFileSync(join(repo, "README.md"), "# changed again\n", "utf8");
      record();
      git(repo, ["add", "README.md"]);
      record();

      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "new.ts"), "export const a = 1;\n", "utf8");
      record();
      // 未追蹤檔案的內容變了，但 git status 看起來一樣。
      writeFileSync(join(repo, "src", "new.ts"), "export const a = 2;\n", "utf8");
      const beforeIgnore = record();

      // 被 ignore 的檔案不影響指紋（.gitignore 本身是新的未追蹤檔案，先記一次）。
      writeFileSync(join(repo, ".gitignore"), "dist/\n", "utf8");
      const withIgnore = record();
      expect(withIgnore).not.toBe(beforeIgnore);
      mkdirSync(join(repo, "dist"), { recursive: true });
      writeFileSync(join(repo, "dist", "out.js"), "built\n", "utf8");
      expect(captureGitWorkspaceState(repo).treeFingerprint).toBe(withIgnore);

      // 還原所有改動後回到乾淨狀態的指紋。
      git(repo, ["reset", "-q", "--", "README.md"]);
      git(repo, ["checkout", "--", "README.md"]);
      rmSync(join(repo, "src"), { recursive: true });
      rmSync(join(repo, ".gitignore"));
      rmSync(join(repo, "dist"), { recursive: true });
      expect(captureGitWorkspaceState(repo)).toEqual(clean);
    });
  });

  test("還沒有 commit 的 repo 也能產生指紋", async () => {
    await withTempDir("git-state-unborn", async (root) => {
      git(root, ["init", "-q", "-b", "main"]);
      const state = captureGitWorkspaceState(root);
      expect(state).toMatchObject({ isGitRepo: true, gitHead: null, workingTreeClean: true });
      expect(state.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
