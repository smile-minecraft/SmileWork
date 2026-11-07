import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "SmileWork Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "SmileWork Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} 失敗（${exitCode}）：${stderr || stdout}`);
  }
  return stdout.trim();
}

/** 建立含一個 commit 的 git repo，回傳專案根目錄。 */
export async function createGitRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "SmileWork Test"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "# fixture\n", "utf8");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

/** 在既有 repo 建立 worktree，回傳 worktree 路徑。 */
export async function createGitWorktree(repo: string, worktreePath: string, branch: string): Promise<string> {
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, worktreePath]);
  return worktreePath;
}

/** 搬移整個 git repo 目錄，用來模擬 relink。 */
export async function moveDirectory(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}
