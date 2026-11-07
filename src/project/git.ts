import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GitLocation {
  /** 這次解析的 worktree 根目錄。 */
  rootPath: string;
  /** 主 worktree 根目錄；linked worktree 也會回主 repo，不會被覆寫。 */
  mainWorktreePath: string;
  /** 所有 worktree 共用的 git common dir，已經過 realpath 正規化。 */
  commonDir: string;
  /** 這個 worktree 自己的 git dir。 */
  gitDir: string;
}

function existingDirectory(input: string): string | null {
  try {
    const stat = statSync(input);
    const directory = stat.isDirectory() ? input : dirname(input);
    return realpathSync(directory);
  } catch {
    return null;
  }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** `git worktree list --porcelain` 的第一個 worktree 是主 worktree。 */
function mainWorktreeFromPorcelain(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      return line.slice("worktree ".length);
    }
  }
  return null;
}

/** 解析路徑所在的 git worktree；不是 git repo 時回 null。 */
export function gitLocationFor(path: string): GitLocation | null {
  const directory = existingDirectory(path);
  if (!directory) return null;

  try {
    const rootPath = realpathSync(gitOutput(directory, ["rev-parse", "--show-toplevel"]));
    const commonDir = realpathSync(resolve(directory, gitOutput(directory, ["rev-parse", "--git-common-dir"])));
    const gitDir = realpathSync(resolve(directory, gitOutput(directory, ["rev-parse", "--git-dir"])));
    const mainRaw = mainWorktreeFromPorcelain(gitOutput(directory, ["worktree", "list", "--porcelain"]));
    const mainWorktreePath = mainRaw ? realpathSync(mainRaw) : rootPath;
    return { rootPath, mainWorktreePath, commonDir, gitDir };
  } catch {
    return null;
  }
}
