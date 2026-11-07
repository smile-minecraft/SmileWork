import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMissingPathError } from "./errors.ts";
import { resolveHookLocation } from "./git.ts";
import { isManagedHook, renderPreCommitHook, type HookCommand } from "./template.ts";

export type HookInstallStatus = "installed" | "updated" | "unchanged" | "replaced" | "blocked";

export type HookUninstallStatus = "removed" | "absent" | "foreign";

export type HookState = "installed" | "absent" | "foreign";

export interface HookInstallResult {
  hookPath: string;
  status: HookInstallStatus;
}

export interface HookUninstallResult {
  hookPath: string;
  status: HookUninstallStatus;
}

export interface HookStatusResult {
  hookPath: string;
  state: HookState;
  managed: boolean;
}

export interface InstallPreCommitOptions {
  projectPath: string;
  /** 既有 hook 不是 smilework 建立時，是否覆蓋。 */
  force: boolean;
  command: HookCommand;
}

type HookSnapshot =
  | { kind: "absent" }
  | { kind: "managed" | "foreign"; content: string; symlink: boolean };

/** symlink 一律視為別人的 hook；不讀寫它指向的檔案，避免意外改到 hooks 目錄外的內容。 */
function snapshot(path: string): HookSnapshot {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return { kind: "absent" };
    throw error;
  }

  if (info.isSymbolicLink()) {
    let content = "";
    try {
      content = readFileSync(path, "utf8");
    } catch {
      // 斷鏈也維持 foreign，只讓訊息判斷用。
    }
    return { kind: "foreign", content, symlink: true };
  }

  const content = readFileSync(path, "utf8");
  return { kind: isManagedHook(content) ? "managed" : "foreign", content, symlink: false };
}

function writeHook(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

/**
 * 安裝 pre-commit。既有 hook 不是本工具建立時，沒有 force 就回 blocked，
 * 任何情況下都不會先寫入再回報失敗。
 */
export function installPreCommitHook(options: InstallPreCommitOptions): HookInstallResult {
  const { hookPath } = resolveHookLocation(options.projectPath);
  const content = renderPreCommitHook(options.command);
  const existing = snapshot(hookPath);

  if (existing.kind === "foreign") {
    if (!options.force) return { hookPath, status: "blocked" };
    if (existing.symlink) rmSync(hookPath, { force: true });
    writeHook(hookPath, content);
    return { hookPath, status: "replaced" };
  }

  if (existing.kind === "managed" && existing.content === content) {
    return { hookPath, status: "unchanged" };
  }

  writeHook(hookPath, content);
  return { hookPath, status: existing.kind === "absent" ? "installed" : "updated" };
}

/** 只移除帶有 smilework 標記的 hook；別人的 hook 與 symlink 一律保留。 */
export function uninstallPreCommitHook(projectPath: string): HookUninstallResult {
  const { hookPath } = resolveHookLocation(projectPath);
  const existing = snapshot(hookPath);

  if (existing.kind === "absent") return { hookPath, status: "absent" };
  if (existing.kind === "foreign") return { hookPath, status: "foreign" };

  rmSync(hookPath, { force: true });
  return { hookPath, status: "removed" };
}

export function readHookStatus(projectPath: string): HookStatusResult {
  const { hookPath } = resolveHookLocation(projectPath);
  const existing = snapshot(hookPath);

  if (existing.kind === "absent") return { hookPath, state: "absent", managed: false };
  if (existing.kind === "managed") return { hookPath, state: "installed", managed: true };
  return { hookPath, state: "foreign", managed: false };
}
