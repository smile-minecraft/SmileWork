/**
 * 驗證 runner 的白名單：script family、逐 runner 旗標與 argv 組裝。
 * script 只描述「要跑哪一種驗證」，目標與旗標一律放進 args，避免把任意命令塞進 script。
 */

export const SUPPORTED_RUNNERS = ["bun", "npm", "pytest", "cargo", "gradle", "swift"] as const;
export type VerifyRunner = (typeof SUPPORTED_RUNNERS)[number];

export const PACKAGE_RUNNERS: ReadonlySet<VerifyRunner> = new Set(["bun", "npm"]);

/** 套件管理器可單獨使用的 script family；後綴只描述同一種驗證的分組。 */
export const STANDALONE_SCRIPT_FAMILIES = ["test", "lint", "typecheck", "check", "verify"] as const;

/** 只能帶特定後綴的 family：裸 format 慣例上會改檔，不是驗證。 */
export const SUFFIX_ONLY_SCRIPT_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  format: ["check", "verify"],
};

export const MAX_ARG_COUNT = 128;
export const MAX_ARG_LENGTH = 512;

const STANDALONE_SCRIPT_PATTERN = new RegExp(
  `^(${STANDALONE_SCRIPT_FAMILIES.join("|")})(?::[A-Za-z0-9._-]+)*$`,
);
const SUFFIX_ONLY_SCRIPT_PATTERN = new RegExp(
  `^(${Object.entries(SUFFIX_ONLY_SCRIPT_FAMILIES)
    .map(([base, suffixes]) => `${base}:(${suffixes.join("|")})`)
    .join("|")})$`,
);

// 套件 runner 的 args 會原樣轉交給具名 script，底層命令未知；只放行常見的
// 測試篩選與輸出旗標。會寫檔的旗標（--fix／--write）不在白名單。
const PACKAGE_RUNNER_FILTER_FLAGS = [
  "-t",
  "--testNamePattern",
  "--testPathPattern",
  "--grep",
  "--filter",
  "-k",
  "-q",
  "--silent",
  "-v",
  "--verbose",
] as const;

/**
 * 逐 runner 的旗標白名單，沿用舊版驗證工具：
 * - 位置參數（不以 - 開頭）一律放行，路徑 containment 另外檢查。
 * - 只放行選測試與調輸出的讀取型旗標。
 * - pytest 的 -p 會載入外掛，因此不在清單；cargo 的 -p 是選套件，可以放行。
 */
export const EXTRA_ARG_FLAG_ALLOWLIST: Readonly<Record<VerifyRunner, readonly string[]>> = {
  bun: PACKAGE_RUNNER_FILTER_FLAGS,
  npm: PACKAGE_RUNNER_FILTER_FLAGS,
  pytest: [
    "-q",
    "-v",
    "-s",
    "-x",
    "--maxfail",
    "-k",
    "-m",
    "--tb",
    "--no-header",
    "-rf",
    "--collect-only",
    "--co",
  ],
  cargo: [
    "-p",
    "--package",
    "--test",
    "--tests",
    "--lib",
    "--bins",
    "--all-targets",
    "--no-run",
    "--no-fail-fast",
    "--skip",
    "--exact",
    "--ignored",
    "--include-ignored",
    "--manifest-path",
    "--offline",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
  ],
  gradle: [],
  swift: ["--filter", "--skip", "-v", "--verbose", "--parallel", "--num-workers"],
};

export interface ArgsAccepted {
  ok: true;
}

export interface ArgsRejected {
  ok: false;
  rejectedArg: string;
  allowed: readonly string[];
  message: string;
}

export type ArgsValidation = ArgsAccepted | ArgsRejected;

export function isSupportedRunner(value: string): value is VerifyRunner {
  return (SUPPORTED_RUNNERS as readonly string[]).includes(value);
}

export function isPackageScriptAllowed(script: string): boolean {
  return STANDALONE_SCRIPT_PATTERN.test(script) || SUFFIX_ONLY_SCRIPT_PATTERN.test(script);
}

/**
 * 套件 runner 的 script 必填且落在 family；直接 runner 的 script 只能是空或 test。
 * 直接 runner 的目標與旗標一律放進 args。
 */
export function normalizeScript(runner: VerifyRunner, script: string): string | null {
  if (PACKAGE_RUNNERS.has(runner)) return isPackageScriptAllowed(script) ? script : null;
  return script === "" || script === "test" ? "test" : null;
}

/** 回傳第一個不在白名單的旗標；`--flag=value` 只比對 `=` 之前的旗標名。 */
export function validateExtraArgs(runner: VerifyRunner, args: readonly string[]): ArgsValidation {
  const allowed = EXTRA_ARG_FLAG_ALLOWLIST[runner];
  for (const arg of args) {
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) continue;
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (allowed.includes(flag)) continue;
    return {
      ok: false,
      rejectedArg: arg,
      allowed,
      message: `不允許的參數：${arg}（runner: ${runner}）。這個 runner 只允許這些旗標：${allowed.join("、") || "（沒有額外旗標）"}；測試檔或測試名稱請用位置參數。`,
    };
  }
  return { ok: true };
}

/** Gradle 只執行固定的 test task，額外參數只允許重跑與測試篩選。 */
export function validateGradleArgs(args: readonly string[]): ArgsValidation {
  const allowed = ["--rerun-tasks", "--tests <pattern>"] as const;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--rerun-tasks") continue;
    if (arg === "--tests") {
      const pattern = args[index + 1];
      if (!pattern || pattern.startsWith("-")) {
        return {
          ok: false,
          rejectedArg: arg,
          allowed,
          message: "Gradle 的 --tests 需要一個不以 - 開頭的測試樣式。",
        };
      }
      index += 1;
      continue;
    }
    return {
      ok: false,
      rejectedArg: arg,
      allowed,
      message: `不允許的 Gradle 參數：${arg}。Gradle 只執行 test task，額外參數只允許 --rerun-tasks 與 --tests <pattern>。`,
    };
  }
  return { ok: true };
}

export function executableForRunner(runner: VerifyRunner): string {
  return runner;
}

/** 依 runner 組出 argv；executable 由呼叫端解析成專案內 wrapper 或 PATH 上的絕對路徑。 */
export function buildRunnerCommand(
  runner: VerifyRunner,
  script: string,
  args: readonly string[],
  executable: string,
): string[] {
  if (runner === "bun") return [executable, "run", script, ...args];
  if (runner === "npm") return [executable, "run", script, "--", ...args];
  if (runner === "gradle") return [executable, "test", ...args];
  if (runner === "pytest") return [executable, ...args];
  return [executable, "test", ...args];
}
