/**
 * 驗證只能在專案根目錄內執行：
 * - cwd 必須存在，且 lexical 與 realpath 都在專案內（擋 symlink 逃逸）。
 * - 參數解析後若是專案外的既有路徑就拒絕；不存在的路徑交給 runner 自己報錯。
 * - Gradle wrapper 必須是 cwd 內的普通可執行檔，不能是 symlink。
 */

import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function invalidCwd(message: string, data: Record<string, unknown> = {}): SmileworkError {
  return new SmileworkError(
    "INVALID_CWD",
    message,
    "把 cwd 改成專案內既有的相對路徑，並確認路徑中的 symlink 沒有指向專案外。",
    data,
  );
}

export function resolveProjectRoot(projectRoot: string): string {
  try {
    const path = realpathSync(resolve(projectRoot));
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    return path;
  } catch {
    throw new SmileworkError(
      ERROR_CODES.projectNotFound,
      `專案根目錄不存在或無法解析：${projectRoot}`,
      "確認 SMILEWORK_PROJECT 或工具參數指向存在的 git repo。",
      { projectRoot },
    );
  }
}

export function resolveWorkingDirectory(projectRoot: string, requested?: string): string {
  const root = resolveProjectRoot(projectRoot);
  const raw = requested?.trim() || ".";
  const lexical = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!isInside(root, lexical)) {
    throw invalidCwd(`工作目錄不在專案內：${raw}`, { cwd: raw, projectRoot: root });
  }

  let resolved: string;
  try {
    resolved = realpathSync(lexical);
  } catch {
    throw invalidCwd(`工作目錄不存在或無法解析：${raw}`, { cwd: raw, projectRoot: root });
  }
  if (!isInside(root, resolved)) {
    throw invalidCwd(`工作目錄的 symlink 指向專案外：${raw}`, { cwd: raw, projectRoot: root });
  }
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    throw invalidCwd(`工作目錄不是資料夾：${raw}`, { cwd: raw, projectRoot: root });
  }
  return resolved;
}

/**
 * 逐一檢查參數與 `--flag=value` 的 value。只擋「實際存在且不在專案內」的路徑，
 * 避免把測試名稱、套件名稱或 -k 表達式誤判成路徑。
 */
export function findArgumentOutsideProject(
  args: readonly string[],
  cwd: string,
  projectRoot: string,
): string | null {
  const root = canonical(projectRoot);
  const base = canonical(cwd);
  for (const arg of args) {
    const candidates = arg.includes("=") ? [arg, arg.slice(arg.indexOf("=") + 1)] : [arg];
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("-")) continue;
      const resolved = resolve(base, candidate);
      try {
        statSync(resolved);
      } catch {
        continue;
      }
      let resolvedCanonical: string;
      try {
        resolvedCanonical = realpathSync(resolved);
      } catch {
        // 檔案存在但無法解析 realpath（權限或 symlink 問題）時 fail closed。
        return candidate;
      }
      if (!isInside(root, resolvedCanonical)) return candidate;
    }
  }
  return null;
}

export interface GradleWrapperFound {
  ok: true;
  path: string;
}

export interface GradleWrapperRejected {
  ok: false;
  code: string;
  message: string;
  nextAction: string;
}

export type GradleWrapperInspection = GradleWrapperFound | GradleWrapperRejected;

export function inspectGradleWrapper(cwd: string): GradleWrapperInspection {
  const wrapperPath = join(cwd, "gradlew");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(wrapperPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      code: code === "ENOENT" ? "GRADLE_WRAPPER_NOT_FOUND" : "GRADLE_WRAPPER_INVALID",
      message:
        code === "ENOENT"
          ? `找不到 Gradle wrapper：${wrapperPath}。`
          : `無法檢查 Gradle wrapper：${wrapperPath}。`,
      nextAction: "在驗證目錄放入專案自己的 gradlew，並確認它是可執行的普通檔案。",
    };
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return {
      ok: false,
      code: "GRADLE_WRAPPER_INVALID",
      message: `Gradle wrapper 必須是驗證目錄內的普通檔案，且不能是 symbolic link：${wrapperPath}`,
      nextAction: "把 gradlew 放在驗證目錄內，不要用 symlink 指向專案外。",
    };
  }

  try {
    accessSync(wrapperPath, constants.X_OK);
  } catch {
    return {
      ok: false,
      code: "GRADLE_WRAPPER_NOT_EXECUTABLE",
      message: `Gradle wrapper 不可執行：${wrapperPath}`,
      nextAction: "執行 chmod +x gradlew，或確認檔案權限。",
    };
  }

  return { ok: true, path: realpathSync(wrapperPath) };
}
