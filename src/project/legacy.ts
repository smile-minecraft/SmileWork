import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizePath } from "../shared/paths.ts";

/**
 * 舊 ultrawork 專案的身分。非 git 資料夾若上層有 `.ultrawork/tasks.json`，
 * 就用裡面記錄的 projectId 接回匯入時的專案，而不是另外建立一個路徑專案。
 */
export interface LegacyProjectIdentity {
  projectId: string;
  /** `.ultrawork` 所在的資料夾，也就是當時的專案根目錄。 */
  rootPath: string;
  /** 舊 `tasks.json` 記錄的 projectPath；沒有記錄時省略。 */
  projectPath?: string;
}

interface LegacyRegistry {
  projectId?: unknown;
  projectPath?: unknown;
}

function readRegistry(path: string): LegacyRegistry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as LegacyRegistry;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 從來源路徑往上找最近的 `.ultrawork/tasks.json` 或 `plans.json`。
 * 走到使用者家目錄就停止檢查上一層，避免 `~/dev/new-project` 誤認成
 * 家目錄本身的舊專案；家目錄自己仍然可以當成舊專案。
 */
export function findLegacyProjectIdentity(
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): LegacyProjectIdentity | null {
  const home = canonicalizePath(env.HOME?.trim() ? env.HOME : homedir());
  const start = canonicalizePath(sourcePath);
  let current = start;

  for (;;) {
    // 從家目錄底下的新資料夾往上找時，不要把家目錄自己的舊專案當成上層專案。
    if (current === home && start !== home) return null;

    for (const name of ["tasks.json", "plans.json"]) {
      const path = join(current, ".ultrawork", name);
      if (!existsSync(path)) continue;
      const registry = readRegistry(path);
      const projectId = nonEmptyString(registry?.projectId);
      if (projectId === undefined) continue;
      const projectPath = nonEmptyString(registry?.projectPath);
      return {
        projectId,
        rootPath: current,
        ...(projectPath === undefined ? {} : { projectPath }),
      };
    }

    if (current === home) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
