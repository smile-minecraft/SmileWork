import { delimiter, join, resolve, sep } from "node:path";
import { expandHome } from "../shared/paths.ts";
import { TRANSCRIPT_SOURCES, type TranscriptSource } from "./types.ts";

export interface TranscriptConfig {
  readonly sources: Readonly<Record<TranscriptSource, boolean>>;
  /** 排除的專案根目錄；命中的專案完全不做索引。 */
  readonly excludeProjects: readonly string[];
  readonly maxEntryChars: number;
  readonly maxFileBytes: number;
  readonly refreshMs: number;
}

export interface TranscriptPaths {
  readonly claudeDir: string;
  readonly codexDir: string;
  readonly opencodeDb: string;
  readonly piDir: string;
}

const DEFAULT_MAX_ENTRY_CHARS = 20_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_REFRESH_MS = 60_000;

function readInteger(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.trunc(parsed);
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 來源設定以環境變數為準，讓不同宿主可以只關閉自己不要的來源：
 * `SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES=codex,opencode`。
 * 專案排除清單使用作業系統的路徑分隔字元。
 */
export function readTranscriptConfig(env: NodeJS.ProcessEnv = process.env): TranscriptConfig {
  const disabled = new Set(splitList(env.SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES));
  const enabled = splitList(env.SMILEWORK_TRANSCRIPTS_ENABLED_SOURCES);
  const sources = Object.fromEntries(
    TRANSCRIPT_SOURCES.map((source) => {
      const globallyEnabled = enabled.length === 0 || enabled.includes(source);
      return [source, globallyEnabled && !disabled.has(source)];
    }),
  ) as Record<TranscriptSource, boolean>;

  const home = env.HOME ?? "";
  const excludeProjects = (env.SMILEWORK_TRANSCRIPTS_EXCLUDE_PROJECTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeProjectPath(item, home));

  return {
    sources,
    excludeProjects,
    maxEntryChars: readInteger(
      env.SMILEWORK_TRANSCRIPTS_MAX_ENTRY_CHARS,
      DEFAULT_MAX_ENTRY_CHARS,
      100,
    ),
    maxFileBytes: readInteger(
      env.SMILEWORK_TRANSCRIPTS_MAX_FILE_BYTES,
      DEFAULT_MAX_FILE_BYTES,
      4096,
    ),
    refreshMs: readInteger(env.SMILEWORK_TRANSCRIPTS_REFRESH_MS, DEFAULT_REFRESH_MS, 0),
  };
}

/** 解析三個來源的預設位置；環境變數可覆寫，測試與非標準安裝都靠這個。 */
export function transcriptPaths(env: NodeJS.ProcessEnv = process.env): TranscriptPaths {
  const home = env.HOME ?? "";
  const dataHome = env.XDG_DATA_HOME?.trim()
    ? expandHome(env.XDG_DATA_HOME.trim(), home)
    : join(home, ".local", "share");

  return {
    claudeDir: env.SMILEWORK_CLAUDE_PROJECTS_DIR
      ? expandHome(env.SMILEWORK_CLAUDE_PROJECTS_DIR, home)
      : join(home, ".claude", "projects"),
    codexDir: env.SMILEWORK_CODEX_SESSIONS_DIR
      ? expandHome(env.SMILEWORK_CODEX_SESSIONS_DIR, home)
      : join(home, ".codex", "sessions"),
    opencodeDb: env.SMILEWORK_OPENCODE_DB
      ? expandHome(env.SMILEWORK_OPENCODE_DB, home)
      : join(dataHome, "opencode", "opencode.db"),
    piDir: env.SMILEWORK_PI_SESSIONS_DIR
      ? expandHome(env.SMILEWORK_PI_SESSIONS_DIR, home)
      : join(home, ".pi", "agent", "sessions"),
  };
}

export function normalizeProjectPath(input: string, home: string = process.env.HOME ?? ""): string {
  const expanded = expandHome(input.trim(), home);
  const withoutTrailing = expanded.replace(/[\\/]+$/, "");
  return withoutTrailing === "" ? resolve("/") : resolve(withoutTrailing);
}

export function isProjectExcluded(
  projectPath: string | undefined,
  excludeProjects: readonly string[],
): boolean {
  if (!projectPath || excludeProjects.length === 0) return false;
  const normalized = normalizeProjectPath(projectPath);
  return excludeProjects.some(
    (excluded) => normalized === excluded || normalized.startsWith(`${excluded}${sep}`),
  );
}

/** 來源與排除清單變動時要重新建立索引；只比較會影響索引的設定。 */
export function transcriptConfigFingerprint(config: TranscriptConfig): string {
  const sources = TRANSCRIPT_SOURCES.map(
    (source) => `${source}=${config.sources[source] ? "1" : "0"}`,
  ).join(",");
  const excluded = [...config.excludeProjects].sort().join("\u0000");
  return `${sources}|${excluded}`;
}
