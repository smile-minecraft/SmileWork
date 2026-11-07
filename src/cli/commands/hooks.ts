import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, SmileworkError } from "../../shared/errors.ts";
import { failureFromError } from "../../shared/result.ts";
import type { Command } from "../command.ts";
import { checkStagedWorkIds, type StagedCheckResult } from "../hooks/check.ts";
import { isMissingPathError, messageOf } from "../hooks/errors.ts";
import {
  installPreCommitHook,
  readHookStatus,
  uninstallPreCommitHook,
} from "../hooks/install.ts";
import type { HookCommand } from "../hooks/template.ts";

const USAGE = [
  "用法：smilework hooks <install|uninstall|status|check> [參數]",
  "",
  "子命令：",
  "  install    安裝 pre-commit 的 ID 檢查；--project <path>、--force 覆蓋既有 hook",
  "  uninstall  移除本工具建立的 pre-commit；別人的 hook 不會被動到",
  "  status     顯示 pre-commit 是否已安裝",
  "  check      檢查暫存變更是否含已登記 ID；--staged、--quiet、--json",
  "",
].join("\n");

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const separator = body.indexOf("=");
    if (separator >= 0) {
      values.set(body.slice(0, separator), body.slice(separator + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      index += 1;
    } else {
      flags.add(body);
    }
  }

  return { positionals, values, flags };
}

/** 安裝 hook 時要寫進檔案的執行指令；原始碼執行與打包後都能找到入口。 */
function cliInvocation(): HookCommand {
  const moduleEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
  if (existsSync(moduleEntry)) return { file: process.execPath, args: [moduleEntry] };

  const scriptEntry = process.argv[1];
  if (scriptEntry !== undefined && existsSync(scriptEntry)) {
    return { file: process.execPath, args: [scriptEntry] };
  }
  return { file: process.execPath, args: [] };
}

function projectPath(args: ParsedArgs): string {
  return args.values.get("project") ?? process.cwd();
}

function invalidArgs(message: string): SmileworkError {
  return new SmileworkError(
    ERROR_CODES.invalidInput,
    message,
    "修正參數後重新執行 smilework hooks <子命令>。",
  );
}

/** 每個子命令只接受自己的參數，打錯字或漏值時直接報錯。 */
function assertKnownArgs(
  args: ParsedArgs,
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
): void {
  for (const key of args.values.keys()) {
    if (!valueOptions.has(key)) throw invalidArgs(`不支援的參數：--${key}`);
  }
  for (const flag of args.flags) {
    if (valueOptions.has(flag)) throw invalidArgs(`--${flag} 缺少值。`);
    if (!booleanOptions.has(flag)) throw invalidArgs(`不支援的參數：--${flag}`);
  }
  if (args.positionals.length > 0) {
    throw invalidArgs(`不支援的參數：${args.positionals.join("、")}`);
  }
}

const INSTALL_VALUES = new Set(["project"]);
const INSTALL_FLAGS = new Set(["force", "json"]);
const UNINSTALL_VALUES = new Set(["project"]);
const UNINSTALL_FLAGS = new Set(["json"]);
const CHECK_VALUES = new Set(["project"]);
const CHECK_FLAGS = new Set(["staged", "quiet", "json"]);

function printFailure(error: unknown): void {
  const failure = failureFromError(error);
  console.error(`錯誤：${failure.message}`);
  console.error(`下一步：${failure.nextAction}`);
}

function runInstall(args: ParsedArgs): number {
  assertKnownArgs(args, INSTALL_VALUES, INSTALL_FLAGS);
  const result = installPreCommitHook({
    projectPath: projectPath(args),
    force: args.flags.has("force"),
    command: cliInvocation(),
  });

  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.status === "blocked") {
    console.error(`既有 pre-commit hook 不是 smilework 建立，未覆蓋：${result.hookPath}`);
    console.error("下一步：確認既有 hook 的內容後，加上 --force 覆蓋，或先備份並移除它。");
  } else if (result.status === "unchanged") {
    console.log(`pre-commit hook 已是最新：${result.hookPath}`);
  } else if (result.status === "replaced") {
    console.log(`已覆蓋既有 pre-commit hook：${result.hookPath}`);
  } else {
    console.log(`已安裝 pre-commit hook：${result.hookPath}`);
  }

  return result.status === "blocked" ? 1 : 0;
}

function runUninstall(args: ParsedArgs): number {
  assertKnownArgs(args, UNINSTALL_VALUES, UNINSTALL_FLAGS);
  const result = uninstallPreCommitHook(projectPath(args));
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (result.status === "removed") {
    console.log(`已移除 pre-commit hook：${result.hookPath}`);
  } else if (result.status === "absent") {
    console.log(`沒有安裝 pre-commit hook：${result.hookPath}`);
  } else {
    console.log(`pre-commit hook 不是 smilework 建立，未移除：${result.hookPath}`);
  }
  return 0;
}

function runStatus(args: ParsedArgs): number {
  assertKnownArgs(args, UNINSTALL_VALUES, UNINSTALL_FLAGS);
  const result = readHookStatus(projectPath(args));
  if (args.flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify({
        hookPath: result.hookPath,
        installed: result.state === "installed",
        managed: result.managed,
        foreign: result.state === "foreign",
      })}\n`,
    );
    return 0;
  }

  if (result.state === "installed") console.log(`已安裝：${result.hookPath}`);
  else if (result.state === "foreign") console.log(`既有 hook 不是 smilework 建立：${result.hookPath}`);
  else console.log(`未安裝：${result.hookPath}`);
  return 0;
}

function runCheck(args: ParsedArgs): number {
  assertKnownArgs(args, CHECK_VALUES, CHECK_FLAGS);
  let result: StagedCheckResult;
  try {
    result = checkStagedWorkIds({ projectPath: projectPath(args), env: process.env });
  } catch (error) {
    if (error instanceof SmileworkError) {
      printFailure(error);
      return 1;
    }
    // hook 是選配的檢查；讀不到資料庫或 diff 時只提示，不擋下提交。
    if (!isMissingPathError(error)) {
      console.error(`警告：ID 檢查略過：${messageOf(error)}`);
    }
    return 0;
  }

  if (args.flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify({
        ok: result.findings.length === 0,
        registered: result.registered,
        findings: result.findings,
      })}\n`,
    );
  } else if (result.findings.length === 0) {
    if (!args.flags.has("quiet")) console.log("沒有發現已登記的工作或計畫 ID。");
  } else {
    console.error("提交內容含有已登記的工作或計畫 ID：");
    for (const finding of result.findings) {
      const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
      console.error(`  ${where}  ${finding.id}`);
    }
    console.error("下一步：移除內容裡的內部識別碼，改用功能或模組名稱描述。");
  }

  return result.findings.length === 0 ? 0 : 1;
}

export const command: Command = {
  description: "管理 git pre-commit 的 ID 檢查",
  run(args: readonly string[]): number {
    const [first] = args;
    if (
      first === undefined ||
      args.includes("--help") ||
      args.includes("-h")
    ) {
      process.stdout.write(USAGE);
      return 0;
    }

    const parsed = parseArgs(args);
    const [subcommand] = parsed.positionals;
    const rest: ParsedArgs = { ...parsed, positionals: parsed.positionals.slice(1) };

    try {
      if (subcommand === "install") return runInstall(rest);
      if (subcommand === "uninstall") return runUninstall(rest);
      if (subcommand === "status") return runStatus(rest);
      if (subcommand === "check") return runCheck(rest);
    } catch (error) {
      printFailure(error);
      return 1;
    }

    process.stderr.write(`未知的 hooks 子命令：${subcommand}\n\n${USAGE}`);
    return 1;
  },
};
