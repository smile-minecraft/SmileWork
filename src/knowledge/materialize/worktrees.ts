import type { Database } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { SmileworkError } from "../../shared/errors.ts";
import { KNOWLEDGE_TOOL_ERROR_CODES } from "./errors.ts";
import { assertPathSegment } from "./paths.ts";

export interface ProjectSkillLocation {
  worktreePath: string;
  artifactPath: string;
}

interface WorktreeRow {
  worktree_path: string;
}

export interface ProjectSkillLocationOptions {
  /** 已經退役的項目允許找不到實體檔，回 null。 */
  allowMissing?: boolean;
}

function registeredWorktrees(
  db: Database,
  projectId: string,
  currentWorktreePath: string | undefined,
): string[] {
  const candidates = new Set<string>();
  if (currentWorktreePath) candidates.add(resolve(currentWorktreePath));
  const rows = db
    .query<WorktreeRow, [string]>(
      "SELECT worktree_path FROM project_worktrees WHERE project_id = ? ORDER BY worktree_path",
    )
    .all(projectId);
  for (const row of rows) candidates.add(resolve(row.worktree_path));
  return [...candidates];
}

/**
 * 找出專案技能真正落在哪個 worktree。只認已登記的 worktree 與目前 worktree，
 * 不掃描專案外的路徑。
 */
export function findProjectSkillLocations(
  db: Database,
  projectId: string,
  knowledgeId: string,
  currentWorktreePath: string | undefined,
): ProjectSkillLocation[] {
  assertPathSegment(knowledgeId, "knowledgeId");
  const seen = new Set<string>();
  const locations: ProjectSkillLocation[] = [];

  for (const candidate of registeredWorktrees(db, projectId, currentWorktreePath)) {
    let worktreePath: string;
    try {
      worktreePath = realpathSync(candidate);
    } catch {
      continue;
    }
    if (seen.has(worktreePath)) continue;
    seen.add(worktreePath);

    const artifactPath = join(worktreePath, ".agents", "skills", knowledgeId);
    try {
      const artifact = lstatSync(artifactPath);
      if (artifact.isSymbolicLink() || !artifact.isDirectory()) continue;
      if (!lstatSync(join(artifactPath, "SKILL.md")).isFile()) continue;
    } catch {
      continue;
    }
    locations.push({ worktreePath, artifactPath });
  }

  return locations.sort((left, right) =>
    left.worktreePath.localeCompare(right.worktreePath),
  );
}

/**
 * 專案技能只能有一個實體來源。找不到或同時出現在多個 worktree 時 fail closed，
 * 不猜哪一份才是正確的，避免留下另一份 active 技能。
 */
export function requireProjectSkillLocation(
  db: Database,
  projectId: string,
  knowledgeId: string,
  currentWorktreePath: string | undefined,
  options: ProjectSkillLocationOptions = {},
): ProjectSkillLocation | null {
  const locations = findProjectSkillLocations(
    db,
    projectId,
    knowledgeId,
    currentWorktreePath,
  );

  if (locations.length === 1) return locations[0]!;
  if (locations.length === 0 && options.allowMissing === true) return null;
  if (locations.length === 0) {
    throw new SmileworkError(
      KNOWLEDGE_TOOL_ERROR_CODES.artifactNotFound,
      `找不到專案技能 ${knowledgeId} 的實體檔案。`,
      "確認技能在目前 worktree 或專案其他已登記 worktree 的 .agents/skills/<name>/SKILL.md；若實體檔已遺失，先從版本歷史或備份還原，再升級、退役或更新。",
      {
        knowledgeId,
        projectId,
        currentWorktreePath: currentWorktreePath ?? null,
        worktrees: registeredWorktrees(db, projectId, currentWorktreePath),
      },
    );
  }

  throw new SmileworkError(
    KNOWLEDGE_TOOL_ERROR_CODES.artifactAmbiguous,
    `專案技能 ${knowledgeId} 同時出現在多個 worktree，無法安全判斷要處理哪一份。`,
    "只保留一個 worktree 的實體技能，移除其他 worktree 的同名資料夾後再試；不要在不明確時升級或退役。",
    {
      knowledgeId,
      projectId,
      worktrees: locations.map((location) => location.worktreePath),
    },
  );
}
