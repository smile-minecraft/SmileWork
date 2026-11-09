/**
 * 三種工具 profile 與兩層設定檔。
 *
 * worker 給一般執行代理、curator 給整理代理、full 保留全部工具。
 * 未設定時預設 worker，讓一般代理只看到 12 個工具；需要完整能力時
 * 用 SMILEWORK_PROFILE 或全域 config.jsonc 明確指定 full。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tryResolveProject } from "../project/resolve.ts";
import { parseJsonc } from "../shared/jsonc.ts";
import { smileworkHome } from "../shared/paths.ts";
import { CURATOR_TOOL_NAMES, TOOL_NAMES, WORKER_TOOL_NAMES } from "./tool-names.ts";

export const PROFILE_NAMES = ["worker", "curator", "full"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const DEFAULT_PROFILE: ProfileName = "worker";

export const PROFILE_TOOL_COUNTS: Readonly<Record<ProfileName, number>> = {
  worker: 12,
  curator: 15,
  full: 21,
};

export const PROFILE_TOOLS: Readonly<Record<ProfileName, readonly string[]>> = {
  worker: WORKER_TOOL_NAMES,
  curator: CURATOR_TOOL_NAMES,
  full: TOOL_NAMES,
};

/** 專案層設定只允許這些欄位；profile 與資料庫路徑都屬於使用者層。 */
export const PROJECT_CONFIG_KEYS = ["disabledTools"] as const;

const GLOBAL_CONFIG_KEYS = ["profile", "disabledTools"] as const;

function assertProfileShape(): void {
  const known = new Set(TOOL_NAMES);
  for (const profile of PROFILE_NAMES) {
    const names = PROFILE_TOOLS[profile];
    if (new Set(names).size !== names.length) {
      throw new Error(`profile ${profile} 有重複的工具名稱。`);
    }
    if (names.length !== PROFILE_TOOL_COUNTS[profile]) {
      throw new Error(
        `profile ${profile} 應有 ${PROFILE_TOOL_COUNTS[profile]} 個工具，實際 ${names.length} 個。`,
      );
    }
    for (const name of names) {
      if (!known.has(name)) throw new Error(`profile ${profile} 引用了不存在的工具：${name}`);
    }
  }
}

assertProfileShape();

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 測試或呼叫端明確指定的專案路徑；省略時依 SMILEWORK_PROJECT 與 cwd 解析。 */
  projectPath?: string;
}

export interface SmileworkConfig {
  profile: ProfileName;
  profileSource: "env" | "global" | "default";
  disabledTools: readonly string[];
  /** 依 profile 篩選並套用 disabledTools 後，實際要掛載的工具名稱。 */
  tools: readonly string[];
  files: {
    global: string | null;
    project: string | null;
  };
  warnings: readonly string[];
}

export function isProfileName(value: unknown): value is ProfileName {
  return value === "worker" || value === "curator" || value === "full";
}

export function profileToolNames(
  profile: ProfileName,
  disabledTools: readonly string[] = [],
): readonly string[] {
  const disabled = new Set(disabledTools);
  return PROFILE_TOOLS[profile].filter((name) => !disabled.has(name));
}

/**
 * worker 的 tools/list 有 3000 token 上限。這個 profile 省略 title，
 * 並對最長的說明改用精簡版；工具定義與驗證行為完全不變。
 */
const COMPACT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  verify_run:
    "由伺服器執行白名單 runner 的驗證，留下 serverIssued 證據並關聯到 workId。支援 bun、npm、pytest、cargo、gradle、swift；不接受任意 shell 指令，script、args 與 cwd 都有限制。",
};

export interface ToolPresentation {
  title?: string;
  description: string;
}

export function toolPresentation(
  profile: ProfileName,
  tool: { name: string; title: string; description: string },
): ToolPresentation {
  if (profile !== "worker") {
    return { title: tool.title, description: tool.description };
  }
  return {
    description: COMPACT_DESCRIPTIONS[tool.name] ?? tool.description,
  };
}

interface ConfigLayer {
  values: Record<string, unknown>;
  warnings: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 讀取單層 JSONC；檔案不存在回 null，格式錯誤只留警告。 */
function readConfigLayer(path: string, label: string): ConfigLayer | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {
      values: {},
      warnings: [`無法讀取${label}設定檔 ${path}：${errorMessage(error)}`],
    };
  }

  try {
    const parsed = parseJsonc(text);
    if (!isPlainObject(parsed)) {
      return { values: {}, warnings: [`${label}設定檔必須是 JSON 物件：${path}`] };
    }
    return { values: parsed, warnings: [] };
  } catch (error) {
    return {
      values: {},
      warnings: [`${label}設定檔格式錯誤，已忽略：${path}（${errorMessage(error)}）`],
    };
  }
}

function readProfile(value: unknown, label: string, warnings: string[]): ProfileName | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    warnings.push(`${label}的 profile 必須是字串，已忽略。`);
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!isProfileName(normalized)) {
    warnings.push(`${label}的 profile 不是 worker、curator 或 full，已忽略：${value}`);
    return null;
  }
  return normalized;
}

function readDisabledTools(value: unknown, label: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${label}的 disabledTools 必須是字串陣列，已忽略。`);
    return [];
  }
  const names: string[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      skipped += 1;
      continue;
    }
    names.push(entry.trim());
  }
  if (skipped > 0) {
    warnings.push(`${label}的 disabledTools 有 ${skipped} 個空白或非字串項目，已忽略。`);
  }
  return names;
}

/** 未知名稱不影響工具清單，但要留警告，避免使用者以為工具已停用。 */
function warnUnknownDisabledTools(
  names: readonly string[],
  label: string,
  warnings: string[],
): void {
  const known = new Set(TOOL_NAMES);
  const unknown = [...new Set(names.filter((name) => !known.has(name)))];
  if (unknown.length > 0) {
    warnings.push(`${label}的 disabledTools 有未知工具：${unknown.join("、")}，已忽略。`);
  }
}

function warnUnknownKeys(
  values: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  warnings: string[],
): void {
  const allowedSet = new Set(allowed);
  const ignored = Object.keys(values).filter((key) => !allowedSet.has(key));
  if (ignored.length > 0) {
    warnings.push(`${label}設定已忽略不允許的欄位：${ignored.join("、")}`);
  }
}

/**
 * 依序合併預設值、全域設定、環境變數與專案設定。
 * 專案層只接受 disabledTools，而且只能縮減目前 profile 的工具。
 */
export function loadSmileworkConfig(options: LoadConfigOptions = {}): SmileworkConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  const globalPath = join(smileworkHome(env), "config.jsonc");
  const globalLayer = readConfigLayer(globalPath, "全域");
  if (globalLayer) warnings.push(...globalLayer.warnings);
  const globalValues = globalLayer?.values ?? {};
  warnUnknownKeys(globalValues, GLOBAL_CONFIG_KEYS, "全域", warnings);
  const globalDisabled = readDisabledTools(
    globalValues.disabledTools,
    "全域設定",
    warnings,
  );
  warnUnknownDisabledTools(globalDisabled, "全域設定", warnings);

  const envProfile = readProfile(
    env.SMILEWORK_PROFILE?.trim() === "" ? undefined : env.SMILEWORK_PROFILE,
    "環境變數 SMILEWORK_PROFILE",
    warnings,
  );
  const globalProfile = readProfile(globalValues.profile, "全域設定", warnings);

  let profile: ProfileName;
  let profileSource: SmileworkConfig["profileSource"];
  if (envProfile !== null) {
    profile = envProfile;
    profileSource = "env";
  } else if (globalProfile !== null) {
    profile = globalProfile;
    profileSource = "global";
  } else {
    profile = DEFAULT_PROFILE;
    profileSource = "default";
  }

  const project = tryResolveProject({
    explicitPath: options.projectPath,
    env,
    cwd,
  });
  const projectPath = project ? join(project.rootPath, ".smilework.jsonc") : null;
  const projectLayer = projectPath ? readConfigLayer(projectPath, "專案") : null;
  if (projectLayer) warnings.push(...projectLayer.warnings);
  const projectValues = projectLayer?.values ?? {};
  warnUnknownKeys(projectValues, PROJECT_CONFIG_KEYS, "專案", warnings);
  const projectDisabled = readDisabledTools(
    projectValues.disabledTools,
    "專案設定",
    warnings,
  );
  warnUnknownDisabledTools(projectDisabled, "專案設定", warnings);

  const disabledTools = [...new Set([...globalDisabled, ...projectDisabled])];

  return {
    profile,
    profileSource,
    disabledTools,
    tools: profileToolNames(profile, disabledTools),
    files: {
      global: globalLayer ? globalPath : null,
      project: projectLayer && projectPath ? projectPath : null,
    },
    warnings,
  };
}
