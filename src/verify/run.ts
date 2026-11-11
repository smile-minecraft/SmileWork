/**
 * 受限驗證執行器：先驗證 runner、script、旗標與路徑，再以 argv 直啟程序。
 * 不經過 shell，環境變數由 environment.ts 的白名單決定。
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
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

/** macOS 的 /usr/bin/swift 只是依 xcode-select 轉送的系統 stub。 */
export const MACOS_SWIFT_STUB_PATH = "/usr/bin/swift";
/** 依 DEVELOPER_DIR／xcode-select 找實際 toolchain 的唯一入口。 */
const MACOS_XCRUN_PATH = "/usr/bin/xcrun";
/** xcrun --find 只查路徑，正常在數十毫秒內結束。 */
const SWIFT_TOOLCHAIN_PROBE_TIMEOUT_MS = 5_000;

export interface RunVerificationOptions {
  projectRoot: string;
  runner: string;
  script?: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Swift toolchain 探測的平台事實；省略時用 process.platform 與 /usr/bin/xcrun。 */
  swiftToolchain?: Omit<SwiftToolchainOptions, "env">;
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
  /** 只有在 Swift 失敗且輸出指向工具鏈不一致時才有值。 */
  hint: string | null;
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

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(executable: string, pathValue: string): string | null {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory || ".", executable);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function safeRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** 只有 macOS 上 PATH 解析到 Apple 系統 stub 時，才需要問 xcrun。 */
export function shouldResolveSwiftWithXcrun(
  platform: string,
  executableRealPath: string,
): boolean {
  return platform === "darwin" && executableRealPath === MACOS_SWIFT_STUB_PATH;
}

export interface SwiftToolchainOptions {
  /** 受限驗證環境；xcrun 也走同一份白名單。 */
  env: Record<string, string>;
  /** 測試注入點：預設 process.platform，用來模擬 macOS。 */
  platform?: string;
  /** 測試注入點：預設 /usr/bin/xcrun，用來指向假的 xcrun。 */
  xcrunPath?: string;
  /** 測試注入點：預設 realpathSync；/usr/bin/swift 是測試無法建立的固定路徑。 */
  realPath?: (path: string) => string | null;
}

/** 執行 xcrun --find swift；失敗、逾時或候選不是可執行絕對路徑時回 null。 */
async function findSwiftWithXcrun(
  xcrunPath: string,
  env: Record<string, string>,
): Promise<string | null> {
  let probe: Awaited<ReturnType<typeof runProcess>>;
  try {
    probe = await runProcess({
      command: xcrunPath,
      args: ["--find", "swift"],
      env,
      timeoutMs: SWIFT_TOOLCHAIN_PROBE_TIMEOUT_MS,
      maxOutputBytes: MIN_OUTPUT_BYTES,
    });
  } catch {
    return null;
  }
  if (probe.timedOut || probe.exitCode !== 0) return null;

  const candidate = probe.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return isAbsolute(candidate) && isExecutableFile(candidate) ? candidate : null;
}

/**
 * PATH 上的 swift 若是 Apple 系統 stub，改用 xcrun 依 DEVELOPER_DIR／xcode-select
 * 解析實際 toolchain。任何一步失敗都退回原本的執行檔，不讓驗證因此失敗。
 */
export async function resolveSwiftToolchain(
  executable: string,
  options: SwiftToolchainOptions,
): Promise<string> {
  const real = (options.realPath ?? safeRealPath)(executable);
  if (real === null) return executable;
  if (!shouldResolveSwiftWithXcrun(options.platform ?? process.platform, real)) return executable;

  const xcrunPath = options.xcrunPath ?? MACOS_XCRUN_PATH;
  if (!isExecutableFile(xcrunPath)) return executable;

  return (await findSwiftWithXcrun(xcrunPath, options.env)) ?? executable;
}

/**
 * Swift 失敗訊息只有在 manifest 明確無效（Invalid manifest），或 PackageDescription
 * 與 Undefined symbols 同時出現（manifest link 到錯的 PackageDescription）時，
 * 才判定為工具鏈不一致；單獨出現其中一個也可能是一般的編譯或連結錯誤。
 */
export function swiftToolchainHint(
  runner: VerifyRunner,
  passed: boolean,
  stdout: string,
  stderr: string,
): string | null {
  if (runner !== "swift" || passed) return null;
  const output = `${stdout}\n${stderr}`;
  const invalidManifest = output.includes("Invalid manifest");
  const manifestLinkMismatch =
    output.includes("Undefined symbols") && output.includes("PackageDescription");
  if (!invalidManifest && !manifestLinkMismatch) return null;
  return [
    "Swift 驗證失敗，輸出顯示 manifest 使用的 PackageDescription 與目前選到的 Swift 工具鏈不一致，通常是只裝了 Command Line Tools，或 Xcode 路徑不對。",
    "先依序檢查 `xcode-select -p`、`swift --version`、`xcrun --find swift`；必要時執行 `xcode-select --install` 重裝 Command Line Tools，或把 DEVELOPER_DIR 指向完整 Xcode 的 Contents/Developer（例如 /Applications/Xcode.app/Contents/Developer）。",
  ].join("");
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
    executable =
      runner === "swift"
        ? await resolveSwiftToolchain(found, { ...options.swiftToolchain, env })
        : found;
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

  const passed = !processed.timedOut && processed.exitCode === 0;

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
    passed,
    hint: swiftToolchainHint(runner, passed, processed.stdout, processed.stderr),
  };
}
