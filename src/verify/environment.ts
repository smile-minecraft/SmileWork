/**
 * 驗證程序的環境變數政策：只繼承白名單，排除 token/secret 類鍵，
 * 並強制非互動輸出。pytest 額外禁止寫入 __pycache__。
 */

import { buildSafeEnv } from "../shared/process-runner.ts";
import type { VerifyRunner } from "./runners.ts";

export const VERIFICATION_ENV_ALLOWLIST = [
  // 程序啟動與暫存位置。
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_*",
  "TZ",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  // 六個 runner 的 toolchain／快取位置；不含 proxy、SSH agent 或憑證類變數。
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTFLAGS",
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "SDKROOT",
  "TOOLCHAINS",
  "DEVELOPER_DIR",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_PREFIX",
  "BUN_INSTALL",
] as const;

export function buildVerificationEnv(
  runner: VerifyRunner,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = buildSafeEnv(source, VERIFICATION_ENV_ALLOWLIST);
  env.CI = "1";
  env.NO_COLOR = "1";
  if (runner === "pytest") env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}
