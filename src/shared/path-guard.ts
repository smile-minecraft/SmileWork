import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ERROR_CODES, SmileworkError } from "./errors.ts";
import { claudeSkillsDir, globalSkillsDir, projectSkillsDir, smileworkHome } from "./paths.ts";

export interface GuardRoots {
  readonly smileworkHome: string;
  readonly globalSkills: string;
  readonly projectSkills: string | null;
  readonly linkRoot: string | null;
  readonly all: readonly string[];
}

export interface GuardRootsOptions {
  home?: string;
  smileworkHome?: string;
  projectPath?: string;
  includeLinkRoot?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** 建立這次操作允許的根目錄：資料庫家目錄、兩層技能與選配的 link 根。 */
export function guardRoots(options: GuardRootsOptions = {}): GuardRoots {
  const home = resolve(options.home ?? homedir());
  const homeRoot = resolve(options.smileworkHome ?? smileworkHome(options.env ?? process.env));
  const globalSkills = globalSkillsDir(home);
  const projectSkills = options.projectPath ? projectSkillsDir(resolve(options.projectPath)) : null;
  const linkRoot = options.includeLinkRoot ? claudeSkillsDir(home) : null;

  const all = [
    homeRoot,
    globalSkills,
    ...(projectSkills ? [projectSkills] : []),
    ...(linkRoot ? [linkRoot] : []),
  ];
  return { smileworkHome: homeRoot, globalSkills, projectSkills, linkRoot, all };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function nearestExistingRealPath(path: string): string | null {
  let current = resolve(path);
  for (;;) {
    let exists = false;
    try {
      lstatSync(current);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }

    if (exists) {
      try {
        return realpathSync(current);
      } catch {
        // 路徑存在但無法解析（包含 dangling symlink）→ fail closed。
        return null;
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function pathError(message: string, data: Record<string, unknown> = {}): SmileworkError {
  return new SmileworkError(
    ERROR_CODES.pathNotAllowed,
    message,
    "改用 ~/.smilework、~/.agents/skills 或專案 .agents/skills 內的路徑，並確認路徑中沒有指向範圍外的 symlink。",
    data,
  );
}

function rootList(roots: GuardRoots | readonly string[]): readonly string[] {
  return Array.isArray(roots) ? (roots as readonly string[]) : (roots as GuardRoots).all;
}

/**
 * 目標必須同時通過兩層檢查：
 * 1. lexical 路徑落在某個允許根內，擋掉 .. 與任意絕對路徑。
 * 2. realpath（含 symlink 跟隨）落在某個允許根的 realpath 內，擋掉指向範圍外的 symlink。
 */
export function assertPathAllowed(
  targetPath: string,
  roots: GuardRoots | readonly string[],
  options: { label?: string } = {},
): string {
  if (!isAbsolute(targetPath)) {
    throw pathError(`${options.label ?? "路徑"}必須是絕對路徑：${targetPath}`, { path: targetPath });
  }

  const target = resolve(targetPath);
  const allowedRoots = rootList(roots).map((root) => resolve(root));
  if (!allowedRoots.some((root) => isInside(root, target))) {
    throw pathError(`${options.label ?? "路徑"}不在允許的根目錄內：${target}`, { path: target });
  }

  const canonicalTarget = nearestExistingRealPath(target);
  if (!canonicalTarget) {
    throw pathError(`無法解析路徑的 realpath：${target}`, { path: target });
  }
  const canonicalAllowed = allowedRoots.some((root) => {
    const canonicalRoot = nearestExistingRealPath(root);
    return canonicalRoot !== null && isInside(canonicalRoot, canonicalTarget);
  });
  if (!canonicalAllowed) {
    throw pathError(`${options.label ?? "路徑"}的 symlink 指向允許範圍外：${target}`, { path: target });
  }

  return target;
}

export function isPathAllowed(targetPath: string, roots: GuardRoots | readonly string[]): boolean {
  try {
    assertPathAllowed(targetPath, roots);
    return true;
  } catch {
    return false;
  }
}

/** 把專案或知識項目的相對路徑接到根目錄，先做 lexical 檢查。 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw pathError(`不接受絕對路徑：${relativePath}`, { path: relativePath });
  }
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (!isInside(base, target)) {
    throw pathError(`相對路徑逃逸根目錄：${relativePath}`, { path: relativePath });
  }
  return target;
}

function assertSingleRoot(path: string, root: string, label: string): string {
  const base = resolve(root);
  const target = resolve(path);
  if (!isInside(base, target)) {
    throw pathError(`${label}不在 ${base} 內：${target}`, { path: target });
  }
  const canonicalTarget = nearestExistingRealPath(target);
  const canonicalRoot = nearestExistingRealPath(base);
  if (!canonicalTarget || !canonicalRoot || !isInside(canonicalRoot, canonicalTarget)) {
    throw pathError(`${label}的 symlink 指向 ${base} 之外：${target}`, { path: target });
  }
  return target;
}

function assertCanonicalInsideRoot(path: string, root: string, label: string): void {
  const base = resolve(root);
  const canonicalTarget = nearestExistingRealPath(path);
  const canonicalRoot = nearestExistingRealPath(base);
  if (!canonicalTarget || !canonicalRoot || !isInside(canonicalRoot, canonicalTarget)) {
    throw pathError(`${label}的 realpath 不在 ${base} 內：${path}`, { path });
  }
}

/** 敏感檔名（不分大小寫，比對路徑的每一段）：私鑰、憑證、token 設定檔。 */
const SENSITIVE_FILENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
  ".npmrc",
  ".netrc",
  ".git-credentials",
]);

/** 檔名層級的敏感路徑判斷；.env.example 是唯一豁免。 */
export function isSensitivePath(relativePath: string): boolean {
  const parts = relativePath.split("\\").join("/").split("/").filter(Boolean);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    if (lower === ".env.example") return false;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (SENSITIVE_FILENAMES.has(lower)) return true;
    return /\.(?:pem|key|p12|pfx)$/i.test(lower);
  });
}

/**
 * link 專用檢查：link 位置只能在 link 根，目標只能是全域技能根內的實體。
 * 既有的正確 symlink 允許重跑；既有實體檔案或資料夾留給 link 指令回報衝突。
 */
export function assertLinkTarget(linkPath: string, targetPath: string, roots: GuardRoots): void {
  if (!roots.linkRoot) {
    throw pathError("這個操作沒有啟用 link 根目錄。", { linkPath });
  }

  const link = resolve(linkPath);
  const linkRoot = resolve(roots.linkRoot);
  if (!isInside(linkRoot, link)) {
    throw pathError(`link 位置不在 ${linkRoot} 內：${link}`, { linkPath: link });
  }

  const existing = (() => {
    try {
      return lstatSync(link);
    } catch {
      return null;
    }
  })();

  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw pathError(`link 位置已有實體檔案或資料夾：${link}`, { linkPath: link });
    }
    assertCanonicalInsideRoot(link, roots.globalSkills, "link 目標");
    return;
  }

  const canonicalRoot = nearestExistingRealPath(linkRoot);
  const canonicalLink = nearestExistingRealPath(link);
  if (!canonicalRoot || !canonicalLink || !isInside(canonicalRoot, canonicalLink)) {
    throw pathError(`link 位置的父目錄不在 ${linkRoot} 內：${link}`, { linkPath: link });
  }

  assertSingleRoot(targetPath, roots.globalSkills, "link 目標");
}
