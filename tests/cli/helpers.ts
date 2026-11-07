import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "../helpers/temp.ts";

/** CLI 入口以專案根目錄為工作目錄執行，和平時使用 `bun run` 的方式一致。 */
export const repoRoot = join(import.meta.dir, "..", "..");
export const cliEntry = join(repoRoot, "src", "cli", "index.ts");

/** 測試一律從乾淨的環境開始，避免繼承外部設定的 SMILEWORK_* 與 git 變數。 */
const SCRUBBED_ENV = [
  "SMILEWORK_HOME",
  "SMILEWORK_PROJECT",
  "SMILEWORK_ACTOR",
  "SMILEWORK_MODEL",
  "SMILEWORK_PROFILE",
  "SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
] as const;

export interface CliEnvironment {
  /** 整個測試的暫存根目錄。 */
  root: string;
  /** 使用者的家目錄；技能來源與連結都在這底下。 */
  userHome: string;
  /** SMILEWORK_HOME；資料庫與索引都在這底下。 */
  home: string;
  /** 已指定 HOME 與 SMILEWORK_HOME 的基底環境變數。 */
  env: NodeJS.ProcessEnv;
}

export interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function cleanEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return { ...env, ...overrides };
}

export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string = repoRoot,
): Promise<CliRun> {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd,
    env,
    stdin: "ignore",
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

export async function withCliEnvironment<T>(
  prefix: string,
  run: (context: CliEnvironment) => T | Promise<T>,
): Promise<T> {
  return withTempDir(prefix, async (root) => {
    const userHome = join(root, "user-home");
    const home = join(root, "smilework-home");
    await mkdir(userHome, { recursive: true });
    await mkdir(home, { recursive: true });
    return run({
      root,
      userHome,
      home,
      env: cleanEnvironment({ HOME: userHome, SMILEWORK_HOME: home }),
    });
  });
}

/** 建立使用者層技能，可選擇是否連到 ~/.claude/skills。 */
export async function createUserSkill(
  userHome: string,
  name: string,
  options: { link?: boolean } = {},
): Promise<string> {
  const source = join(userHome, ".agents", "skills", name);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`, "utf8");
  if (options.link !== false) {
    const linkDir = join(userHome, ".claude", "skills");
    await mkdir(linkDir, { recursive: true });
    await symlink(source, join(linkDir, name));
  }
  return source;
}

/** 建立非空的對話索引檔；doctor 只檢查索引是否存在且可讀。 */
export function createTranscriptIndex(home: string): string {
  const path = join(home, "transcripts.db");
  writeFileSync(path, "SQLite format 3\u0000", "utf8");
  return path;
}

/** 依賴 git 的測試用最小的 repo 操作，不引入其他測試目錄的 helper。 */
export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "SmileWork Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "SmileWork Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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

/** 建立含一個 commit 的暫存 repo。 */
export async function createRepo(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.name", "SmileWork Test"]);
  await runGit(dir, ["config", "user.email", "test@example.invalid"]);
  await runGit(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  await runGit(dir, ["add", "README.md"]);
  await runGit(dir, ["commit", "-m", "initial"]);
  return dir;
}

export function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}
