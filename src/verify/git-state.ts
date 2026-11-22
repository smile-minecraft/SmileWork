/**
 * 工作區的 git 指紋：把 HEAD、status、staged／unstaged diff 與未追蹤檔案的內容雜湊
 * 合成一個 SHA-256。任何對追蹤或未追蹤（未被 ignore）檔案的修改都會改變指紋，
 * 讓結案閘門能判斷伺服器證據是不是在目前這份程式碼上跑出來的。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GitWorkspaceState {
  isGitRepo: boolean;
  gitHead: string | null;
  workingTreeClean: boolean | null;
  treeFingerprint: string | null;
}

/** 這些變數會讓 git 指向別的 repo 或 index，指紋必須只看 projectRoot 自己。 */
const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
] as const;

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export const NOT_A_GIT_REPO: GitWorkspaceState = Object.freeze({
  isGitRepo: false,
  gitHead: null,
  workingTreeClean: null,
  treeFingerprint: null,
});

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return env;
}

/** 以 argv 呼叫 git；回傳原始位元組，失敗時丟出例外。 */
export function runGit(cwd: string, args: readonly string[]): Buffer {
  return execFileSync(
    "git",
    ["-C", cwd, "-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
    { env: gitEnv(), stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_MAX_BUFFER },
  );
}

export function runGitText(cwd: string, args: readonly string[]): string {
  return runGit(cwd, args).toString("utf8");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** projectRoot 是不是 git worktree 內的資料夾。 */
export function isInsideGitWorkTree(projectRoot: string): boolean {
  if (!isDirectory(projectRoot)) return false;
  try {
    return runGitText(projectRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function readGitHead(projectRoot: string): string | null {
  try {
    const head = runGitText(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
    return head === "" ? null : head;
  } catch {
    return null;
  }
}

export function gitTopLevel(projectRoot: string): string {
  return runGitText(projectRoot, ["rev-parse", "--show-toplevel"]).trim();
}

/** 未追蹤且沒有被 ignore 的檔案，路徑相對於 repo 頂層並排序。 */
export function listUntrackedFiles(projectRoot: string): string[] {
  const topLevel = gitTopLevel(projectRoot);
  const output = runGitText(topLevel, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
}

/** 檔案內容的雜湊；symlink 只雜湊連結目標字串，不跟進連結。 */
export function hashWorkspaceFile(absolutePath: string): string {
  const hash = createHash("sha256");
  try {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(readlinkSync(absolutePath));
    } else if (stat.isFile()) {
      hash.update(`file\0${stat.mode & 0o111 ? "x" : "-"}\0`);
      hash.update(readFileSync(absolutePath));
    } else {
      hash.update(`other\0${stat.isDirectory() ? "dir" : "special"}`);
    }
  } catch {
    hash.update("unreadable");
  }
  return hash.digest("hex");
}

/**
 * 擷取工作區狀態。不是 git repo 時所有欄位為 null；在 repo 內但 git 指令失敗時，
 * treeFingerprint 為 null，讓閘門 fail closed。
 */
export function captureGitWorkspaceState(projectRoot: string): GitWorkspaceState {
  if (!isInsideGitWorkTree(projectRoot)) return { ...NOT_A_GIT_REPO };

  const gitHead = readGitHead(projectRoot);
  try {
    const topLevel = gitTopLevel(projectRoot);
    const status = runGit(topLevel, ["status", "--porcelain=v1", "-uall", "-z"]);
    const diffFlags = ["--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const cached = runGit(topLevel, ["diff", "--cached", ...diffFlags]);
    const unstaged = runGit(topLevel, ["diff", ...diffFlags]);
    const untracked = listUntrackedFiles(topLevel);

    const hash = createHash("sha256");
    const section = (name: string, content: string | Buffer): void => {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      hash.update(`\n#${name}:${bytes.length}\n`);
      hash.update(bytes);
    };
    section("head", gitHead ?? "UNBORN");
    section("status", status);
    section("cached", cached);
    section("diff", unstaged);
    section(
      "untracked",
      untracked.map((path) => `${path}\0${hashWorkspaceFile(join(topLevel, path))}`).join("\n"),
    );

    return {
      isGitRepo: true,
      gitHead,
      workingTreeClean: status.length === 0,
      treeFingerprint: hash.digest("hex"),
    };
  } catch {
    return { isGitRepo: true, gitHead, workingTreeClean: null, treeFingerprint: null };
  }
}
