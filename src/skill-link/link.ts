import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import {
  claudeSkillsDir,
  expandHome,
  globalSkillsDir,
  piSkillsDir,
  projectPiSkillsDir,
  projectSkillsDir,
} from "../shared/paths.ts";
import { scanSkillsRoot } from "./discover.ts";
import type {
  CrossLayerSkill,
  SkillHost,
  SkillHostSummary,
  SkillLayer,
  SkillLinkResult,
  SkillLinkSummary,
  SkillSourceSummary,
} from "./types.ts";

const DEFAULT_HOSTS: readonly SkillHost[] = ["claude", "pi"];

export interface LinkSkillsOptions {
  /** 使用者家目錄；測試會傳暫存目錄，預設為目前使用者的家目錄。 */
  readonly home?: string;
  /** 專案根目錄；有值時一併連結專案層技能。 */
  readonly projectPath?: string;
  /** 只列出計畫，不建立任何檔案或 symlink。 */
  readonly dryRun?: boolean;
  /** 要處理的宿主；省略時 Claude 一定處理，Pi 只在實際安裝時處理。 */
  readonly hosts?: readonly SkillHost[];
}

interface Candidate {
  readonly name: string;
  readonly layer: SkillLayer;
  readonly sourcePath: string;
}

function invalidInput(message: string, nextAction: string, data: Record<string, unknown> = {}): SmileworkError {
  return new SmileworkError(ERROR_CODES.invalidInput, message, nextAction, data);
}

function assertSkillName(name: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw invalidInput(`技能名稱不合法：${name}`, "技能名稱必須是單一資料夾名稱，不能包含路徑分隔符。", {
      name,
    });
  }
}

async function resolveProjectPath(input: string, home: string): Promise<string> {
  const projectPath = expandHome(input, home);
  let info;
  try {
    info = await stat(projectPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw invalidInput(
        `專案路徑不存在：${projectPath}`,
        "確認 --project 指向既有的專案根目錄。",
        { projectPath },
      );
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw invalidInput(`專案路徑不是資料夾：${projectPath}`, "確認 --project 指向既有的專案根目錄。", {
      projectPath,
    });
  }
  return projectPath;
}

/** 專案層的 Claude Code 技能根目錄；只連到這個專案，不跨專案全域化。 */
function projectClaudeSkillsDir(projectPath: string): string {
  return join(projectPath, ".claude", "skills");
}

function compareNames(
  left: { readonly name: string; readonly layer: SkillLayer },
  right: { readonly name: string; readonly layer: SkillLayer },
): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  const order: Record<SkillLayer, number> = { global: 0, project: 1 };
  return order[left.layer] - order[right.layer];
}

function buildCandidates(
  globalSkills: readonly string[],
  globalRoot: string,
  projectSkills: readonly string[] | null,
  projectRoot: string | null,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const name of globalSkills) {
    assertSkillName(name);
    candidates.push({ name, layer: "global", sourcePath: join(globalRoot, name) });
  }
  if (projectSkills && projectRoot) {
    for (const name of projectSkills) {
      assertSkillName(name);
      candidates.push({ name, layer: "project", sourcePath: join(projectRoot, name) });
    }
  }
  candidates.sort(compareNames);
  return candidates;
}

function findOverlaps(
  host: SkillHost,
  globalSkills: readonly string[],
  projectSkills: readonly string[] | null,
  globalRoot: string,
  projectRoot: string | null,
  globalLinkRoot: string,
  projectLinkRoot: string | null,
): CrossLayerSkill[] {
  if (!projectSkills || !projectRoot || !projectLinkRoot) return [];
  const projectNames = new Set(projectSkills);
  return globalSkills
    .filter((name) => projectNames.has(name))
    .sort()
    .map((name) => ({
      name,
      host,
      globalSourcePath: join(globalRoot, name),
      projectSourcePath: join(projectRoot, name),
      globalLinkPath: join(globalLinkRoot, name),
      projectLinkPath: join(projectLinkRoot, name),
    }));
}

function resolveHosts(
  options: LinkSkillsOptions,
  home: string,
  projectPath: string | null,
): SkillHost[] {
  const requested = [...new Set(options.hosts ?? DEFAULT_HOSTS)];
  if (requested.length === 0) {
    throw invalidInput("至少要指定一個宿主。", "把 hosts 設成 claude 或 pi。");
  }
  const explicitlyRequested = options.hosts !== undefined;
  return requested.filter((host) => {
    if (host === "claude") return true;
    if (explicitlyRequested) return true;
    return (
      existsSync(join(home, ".pi")) ||
      (projectPath !== null && existsSync(join(projectPath, ".pi")))
    );
  });
}

function hostRoots(
  host: SkillHost,
  home: string,
  projectPath: string | null,
): { globalLinkRoot: string; projectLinkRoot: string | null } {
  if (host === "claude") {
    return {
      globalLinkRoot: claudeSkillsDir(home),
      projectLinkRoot: projectPath ? projectClaudeSkillsDir(projectPath) : null,
    };
  }
  return {
    globalLinkRoot: piSkillsDir(home),
    projectLinkRoot: projectPath ? projectPiSkillsDir(projectPath) : null,
  };
}

type ExistingLink =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink"; readonly currentTarget: string }
  | { readonly kind: "other"; readonly label: string };

async function inspectExisting(linkPath: string): Promise<ExistingLink> {
  let info;
  try {
    info = await lstat(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }

  if (info.isSymbolicLink()) {
    try {
      return { kind: "symlink", currentTarget: await readlink(linkPath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
  }
  if (info.isDirectory()) return { kind: "other", label: "實體資料夾" };
  if (info.isFile()) return { kind: "other", label: "實體檔案" };
  return { kind: "other", label: "其他檔案類型" };
}

/**
 * 建立或確認連結根目錄，回傳它實際所在的 realpath。
 * 根目錄本身是 symlink 時，relative target 必須從 realpath 計算，否則第一次建立就會斷鏈。
 */
async function ensureLinkRoot(root: string, dryRun: boolean): Promise<string> {
  if (!dryRun) {
    try {
      await mkdir(root, { recursive: true });
    } catch (error) {
      throw invalidInput(
        `無法建立 link 根目錄 ${root}：${(error as Error).message}`,
        "確認該路徑是資料夾，或移除占用的檔案後重新執行。",
        { linkRoot: root },
      );
    }
  }
  try {
    const realRoot = await realpath(root);
    const info = await stat(realRoot);
    if (!info.isDirectory()) {
      throw invalidInput(
        `link 根目錄不是資料夾：${root}`,
        "確認該路徑是資料夾，或移除占用的檔案後重新執行。",
        { linkRoot: root },
      );
    }
    return realRoot;
  } catch (error) {
    if (error instanceof SmileworkError) throw error;
    if (dryRun && (error as NodeJS.ErrnoException).code === "ENOENT") return resolve(root);
    throw error;
  }
}

async function plannedTarget(root: string, sourcePath: string, dryRun: boolean): Promise<string> {
  const realRoot = await ensureLinkRoot(root, dryRun);
  return relative(realRoot, sourcePath) || sourcePath;
}

/** 只有兩邊的 realpath 都存在且相同，才算已正確連結；斷鏈一律不算。 */
async function pointsTo(linkPath: string, rawTarget: string, sourcePath: string): Promise<boolean> {
  try {
    const linkDir = await realpath(dirname(linkPath));
    const current = await realpath(resolve(linkDir, rawTarget));
    const source = await realpath(sourcePath);
    return current === source;
  } catch {
    return false;
  }
}

async function describeExistingTarget(linkPath: string, rawTarget: string): Promise<string> {
  try {
    const linkDir = await realpath(dirname(linkPath));
    const target = resolve(linkDir, rawTarget);
    try {
      await realpath(target);
      return target;
    } catch {
      return `${target}（目標不存在，斷鏈）`;
    }
  } catch {
    return `${rawTarget}（link 根目錄無法解析）`;
  }
}

async function createSymlink(linkPath: string, target: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function handleCandidate(
  candidate: Candidate,
  host: SkillHost,
  linkRoot: string,
  dryRun: boolean,
): Promise<SkillLinkResult> {
  const linkPath = join(linkRoot, candidate.name);
  const base = {
    name: candidate.name,
    layer: candidate.layer,
    host,
    sourcePath: candidate.sourcePath,
    linkPath,
  } as const;

  const existing = await inspectExisting(linkPath);
  if (existing.kind === "missing") {
    const target = await plannedTarget(linkRoot, candidate.sourcePath, dryRun);
    if (!dryRun) {
      const created = await createSymlink(linkPath, target);
      if (!created) {
        return { ...base, target, outcome: "conflict", reason: "建立時發現項目已存在，未覆蓋" };
      }
    }
    return { ...base, target, outcome: "created" };
  }

  if (existing.kind === "symlink") {
    if (await pointsTo(linkPath, existing.currentTarget, candidate.sourcePath)) {
      return {
        ...base,
        target: existing.currentTarget,
        outcome: "skipped",
        reason: "已連結到相同來源",
      };
    }
    const current = await describeExistingTarget(linkPath, existing.currentTarget);
    return {
      ...base,
      target: existing.currentTarget,
      outcome: "conflict",
      reason: `已存在指向 ${current} 的 symlink，未覆蓋`,
    };
  }

  return { ...base, outcome: "conflict", reason: `已存在${existing.label}，未覆蓋` };
}

/** 把兩層 .agents/skills 的技能各自連到每個宿主的技能根目錄。 */
export async function linkSkills(options: LinkSkillsOptions = {}): Promise<SkillLinkSummary> {
  const home = resolve(options.home ?? homedir());
  const dryRun = options.dryRun ?? false;
  const projectPath = options.projectPath ? await resolveProjectPath(options.projectPath, home) : null;

  const globalRoot = globalSkillsDir(home);
  const globalScan = await scanSkillsRoot(globalRoot);
  const projectRoot = projectPath ? projectSkillsDir(projectPath) : null;
  const projectScan = projectRoot ? await scanSkillsRoot(projectRoot) : null;

  const hosts = resolveHosts(options, home, projectPath);
  const hostSummaries: SkillHostSummary[] = hosts.map((host) => ({
    host,
    ...hostRoots(host, home, projectPath),
  }));

  const sources: SkillSourceSummary[] = [
    {
      layer: "global",
      root: globalRoot,
      exists: globalScan.exists,
      skillCount: globalScan.skills.length,
    },
  ];
  if (projectRoot && projectScan) {
    sources.push({
      layer: "project",
      root: projectRoot,
      exists: projectScan.exists,
      skillCount: projectScan.skills.length,
    });
  }

  const candidates = buildCandidates(
    globalScan.skills,
    globalRoot,
    projectScan?.skills ?? null,
    projectRoot,
  );
  const results: SkillLinkResult[] = [];
  for (const candidate of candidates) {
    for (const target of hostSummaries) {
      const linkRoot = candidate.layer === "global" ? target.globalLinkRoot : target.projectLinkRoot;
      if (!linkRoot) throw invalidInput("缺少專案層 link 根目錄。", "確認 --project 參數。");
      results.push(await handleCandidate(candidate, target.host, linkRoot, dryRun));
    }
  }

  const overlaps: CrossLayerSkill[] = [];
  for (const target of hostSummaries) {
    overlaps.push(
      ...findOverlaps(
        target.host,
        globalScan.skills,
        projectScan?.skills ?? null,
        globalRoot,
        projectRoot,
        target.globalLinkRoot,
        target.projectLinkRoot,
      ),
    );
  }

  const claude = hostSummaries.find((target) => target.host === "claude");
  const primary = claude ?? hostSummaries[0];
  return {
    home,
    globalLinkRoot: primary?.globalLinkRoot ?? claudeSkillsDir(home),
    projectLinkRoot: primary?.projectLinkRoot ?? null,
    projectPath,
    dryRun,
    sources,
    hosts: hostSummaries,
    results,
    overlaps,
  };
}
