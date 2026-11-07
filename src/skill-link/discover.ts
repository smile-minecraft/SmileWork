import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import type { SkillsRootScan } from "./types.ts";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 掃描技能根目錄下第一層的技能。
 * 只接受含 SKILL.md 的資料夾（含指向資料夾的 symlink），其他項目忽略。
 */
export async function scanSkillsRoot(root: string): Promise<SkillsRootScan> {
  let entryNames: string[];
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new SmileworkError(
        ERROR_CODES.invalidInput,
        `技能路徑不是資料夾：${root}`,
        "確認技能根目錄是資料夾，或移除該路徑後重新執行。",
        { root },
      );
    }
    entryNames = (await readdir(root)).sort();
  } catch (error) {
    if (error instanceof SmileworkError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { root, exists: false, skills: [] };
    }
    throw error;
  }

  const skills: string[] = [];
  for (const name of entryNames) {
    const skillPath = join(root, name);
    if (!(await isDirectory(skillPath))) continue;
    if (!(await isFile(join(skillPath, "SKILL.md")))) continue;
    skills.push(name);
  }

  return { root, exists: true, skills };
}
