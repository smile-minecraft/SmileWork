/**
 * 受限驗證執行器：先驗證 runner、script、旗標與路徑，再以 argv 直啟程序。
 * 不經過 shell，環境變數由 environment.ts 的白名單決定。
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { SmileworkError } from "../shared/errors.ts";
import { runProcess } from "../shared/process-runner.ts";
import { buildVerificationEnv } from "./environment.ts";
import {
  buildRunnerCommand,
  executableForRunner,
  isSupportedRunner,
  MAX_ARG_COUNT,
  MAX_ARG_LENGTH,
  normalizeScript,
  validateExtraArgs,
  validateGradleArgs,
  type VerifyRunner,
} from "./runners.ts";
import {
  findArgumentOutsideProject,
  inspectGradleWrapper,
  resolveProjectRoot,
  resolveWorkingDirectory,
} from "./workspace.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = 50;
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
export const MAX_OUTPUT_BYTES = 1_048_576;
const MIN_OUTPUT_BYTES = 512;

export interface RunVerificationOptions {
  projectRoot: string;
  runner: string;
  script?: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface VerificationRunResult {
  runner: VerifyRunner;
  script: string;
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

function invalidArgsError(): SmileworkError {
  const detail = `args 最多 ${MAX_ARG_COUNT} 個，每個不得超過 ${MAX_ARG_LENGTH} 個字元，也不能包含 NUL。`;
  return new SmileworkError("INVALID_ARGS", detail, detail);
}

function scriptError(runner: VerifyRunner, rawScript: string): SmileworkError {
  if (runner === "bun" || runner === "npm") {
    return new SmileworkError(
      "SCRIPT_NOT_ALLOWED",
      `不允許的 script："${rawScript || "（空白）"}"。`,
      '套件 runner 只允許 test／lint／typecheck／check／verify family（可帶 :suffix），或 format:check／format:verify。例如 script: "test"、"test:p0"、"check"；旗標與目標請放入 args。',
      { runner, script: rawScript },
    );
  }
  return new SmileworkError(
    "SCRIPT_NOT_ALLOWED",
    `不允許的 script："${rawScript}"。`,
    `直接 runner（${runner}）的 script 只能省略或填 "test"；測試目標與旗標請放入 args。`,
    { runner, script: rawScript },
  );
}

function argsNotAllowed(runner: VerifyRunner, rejectedArg: string, allowed: readonly string[], message: string): SmileworkError {
  return new SmileworkError(
    "ARGS_NOT_ALLOWED",
    message,
    `移除 ${rejectedArg}，或改用白名單內的旗標。測試檔與測試名稱請用位置參數。`,
    { runner, rejectedArg, allowed },
  );
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function clampOutputBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(MAX_OUTPUT_BYTES, Math.max(MIN_OUTPUT_BYTES, Math.floor(value)));
}

function findExecutableOnPath(executable: string, pathValue: string): string | null {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory || ".", executable);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 繼續找下一個 PATH 項目。
    }
  }
  return null;
}

export async function runVerification(options: RunVerificationOptions): Promise<VerificationRunResult> {
  const args = [...(options.args ?? [])];
  if (
    args.length > MAX_ARG_COUNT ||
    args.some((arg) => arg.length > MAX_ARG_LENGTH || arg.includes("\u0000"))
  ) {
    throw invalidArgsError();
  }

  const runnerName = options.runner.trim();
  if (!isSupportedRunner(runnerName)) {
    throw new SmileworkError(
      "RUNNER_NOT_SUPPORTED",
      `不支援的驗證 runner：${runnerName || "（空白）"}。`,
      "改用 bun、npm、pytest、cargo、gradle 或 swift。",
      { runner: runnerName, supportedRunners: ["bun", "npm", "pytest", "cargo", "gradle", "swift"] },
    );
  }
  const runner = runnerName;

  const rawScript = options.script?.trim() ?? "";
  const script = normalizeScript(runner, rawScript);
  if (script === null) throw scriptError(runner, rawScript);

  if (runner === "gradle") {
    const validation = validateGradleArgs(args);
    if (!validation.ok) {
      throw argsNotAllowed(runner, validation.rejectedArg, validation.allowed, validation.message);
    }
  } else {
    const validation = validateExtraArgs(runner, args);
    if (!validation.ok) {
      throw argsNotAllowed(runner, validation.rejectedArg, validation.allowed, validation.message);
    }
  }

  const projectRoot = resolveProjectRoot(options.projectRoot);
  const cwd = resolveWorkingDirectory(projectRoot, options.cwd);
  const outsidePath = findArgumentOutsideProject(args, cwd, projectRoot);
  if (outsidePath !== null) {
    throw new SmileworkError(
      "ARG_PATH_OUTSIDE_PROJECT",
      `參數指向專案外的既有路徑：${outsidePath}。`,
      "把目標改成專案內、相對於 cwd 的路徑；驗證不會讀取專案外的檔案。",
      { rejectedArg: outsidePath, cwd, projectRoot },
    );
  }

  const env = buildVerificationEnv(runner, options.env ?? process.env);
  let executable: string;
  if (runner === "gradle") {
    const inspection = inspectGradleWrapper(cwd);
    if (!inspection.ok) {
      throw new SmileworkError(inspection.code, inspection.message, inspection.nextAction, { cwd });
    }
    executable = inspection.path;
  } else {
    const name = executableForRunner(runner);
    const found = findExecutableOnPath(name, env.PATH ?? "");
    if (found === null) {
      throw new SmileworkError(
        "RUNNER_NOT_FOUND",
        `找不到驗證工具 ${name}，請確認已安裝且位於 PATH。`,
        "安裝對應的 runner，或把它的執行檔放進 PATH 後重試。",
        { runner, executable: name },
      );
    }
    executable = found;
  }

  const command = buildRunnerCommand(runner, script, args, executable);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const maxOutputBytes = clampOutputBytes(options.maxOutputBytes);

  let processed: Awaited<ReturnType<typeof runProcess>>;
  try {
    processed = await runProcess({
      command: command[0]!,
      args: command.slice(1),
      cwd,
      env,
      timeoutMs,
      maxOutputBytes,
    });
  } catch (error) {
    throw new SmileworkError(
      "SPAWN_FAILED",
      `啟動驗證工具失敗：${error instanceof Error ? error.message : String(error)}`,
      "確認 runner 可執行且 cwd 存在，再重試。",
      { command, cwd },
    );
  }

  return {
    runner,
    script,
    command,
    cwd,
    exitCode: processed.exitCode,
    signal: processed.signal,
    timedOut: processed.timedOut,
    truncated: processed.truncated,
    durationMs: processed.durationMs,
    timeoutMs,
    maxOutputBytes,
    stdout: processed.stdout,
    stderr: processed.stderr,
    passed: !processed.timedOut && processed.exitCode === 0,
  };
}
