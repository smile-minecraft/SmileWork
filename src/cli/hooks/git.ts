import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ERROR_CODES, SmileworkError } from "../../shared/errors.ts";

/** 執行 git 並回傳原始輸出；保留結尾換行與 NUL，交給呼叫端解析。 */
export function gitRaw(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 執行 git 並去掉前後空白；適合單行的 rev-parse 結果。 */
export function gitOutput(cwd: string, args: readonly string[]): string {
  return gitRaw(cwd, args).trim();
}

export interface HookLocation {
  /** repo 的 worktree 根目錄。 */
  rootPath: string;
  /** hooks 目錄；worktree 與 main repo 共用。 */
  hooksDir: string;
  hookPath: string;
}

function notGitRepository(projectPath: string): SmileworkError {
  return new SmileworkError(
    ERROR_CODES.notGitRepository,
    `不是 git repo：${projectPath}`,
    "在 git repo 內執行，或用 --project 指向 repo 或 worktree。",
    { projectPath },
  );
}

/** 從 repo 內的路徑或檔案往上找 git 根目錄；不是 git repo 時丟出帶下一步的錯誤。 */
export function repositoryRoot(projectPath: string): string {
  const cwd = directoryFor(projectPath);
  try {
    const rootPath = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
    if (rootPath !== "") return rootPath;
  } catch {
    // 落到下面統一回報。
  }
  throw notGitRepository(projectPath);
}

/** `git -C` 只接受資料夾；傳入檔案時改用它的上層目錄。 */
function directoryFor(projectPath: string): string {
  try {
    return statSync(projectPath).isDirectory() ? projectPath : dirname(projectPath);
  } catch {
    return projectPath;
  }
}

/** 解析 hooks 目錄；core.hooksPath 有設定時以 git 的答案為準。 */
export function resolveHookLocation(projectPath: string): HookLocation {
  const rootPath = repositoryRoot(projectPath);

  let hooksDir: string;
  try {
    hooksDir = gitOutput(rootPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  } catch {
    hooksDir = resolve(rootPath, gitOutput(rootPath, ["rev-parse", "--git-path", "hooks"]));
  }

  return { rootPath, hooksDir, hookPath: resolve(hooksDir, "pre-commit") };
}
