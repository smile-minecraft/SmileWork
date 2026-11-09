import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** 展開開頭的 ~，其餘路徑一律正規化成絕對路徑。 */
export function expandHome(input: string, home: string = homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/** SmileWork 的家目錄；SMILEWORK_HOME 優先，預設 ~/.smilework。 */
export function smileworkHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SMILEWORK_HOME?.trim();
  if (configured) return expandHome(configured);
  return join(homedir(), ".smilework");
}

export function smileworkDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(smileworkHome(env), "smilework.db");
}

export function smileworkKnowledgeStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(smileworkHome(env), "knowledge-store");
}

export function smileworkTranscriptsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(smileworkHome(env), "transcripts.db");
}

export function globalSkillsDir(home: string = homedir()): string {
  return join(home, ".agents", "skills");
}

export function projectSkillsDir(projectPath: string): string {
  return join(projectPath, ".agents", "skills");
}

export function claudeSkillsDir(home: string = homedir()): string {
  return join(home, ".claude", "skills");
}

export function piAgentDir(home: string = homedir()): string {
  return join(home, ".pi", "agent");
}

export function piSkillsDir(home: string = homedir()): string {
  return join(piAgentDir(home), "skills");
}

export function projectPiSkillsDir(projectPath: string): string {
  return join(projectPath, ".pi", "skills");
}

/**
 * 把路徑正規化成 realpath。路徑尾端還不存在時，從最近存在的祖先取 realpath
 * 再把剩下的片段接回去；/var 這類 symlink 會在祖先層被解析。
 * dangling symlink 會被當成一般名稱接回，不會誤指到其他位置。
 */
export function canonicalizePath(input: string): string {
  let current = resolve(expandHome(input));
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return resolve(input);
      }
      const parent = dirname(current);
      if (parent === current) return resolve(input);
      tail.push(basename(current));
      current = parent;
    }
  }
}
