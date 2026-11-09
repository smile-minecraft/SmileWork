import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { ProjectContext, ProjectRecord, ProjectWorktree } from "../domain/project.ts";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { canonicalizePath } from "../shared/paths.ts";
import { nowIso } from "../shared/time.ts";
import { withImmediateTransaction } from "../db/transaction.ts";
import { resolveProject, type ResolveProjectOptions } from "./resolve.ts";

interface ProjectRow {
  project_id: string;
  common_dir: string;
  root_path: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

interface WorktreeRow {
  project_id: string;
  worktree_path: string;
  git_dir: string | null;
  created_at: string;
  last_seen_at: string;
}

function toRecord(row: ProjectRow, worktrees: readonly ProjectWorktree[]): ProjectRecord {
  return {
    projectId: row.project_id,
    commonDir: row.common_dir,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    worktrees,
  };
}

function toWorktree(row: WorktreeRow): ProjectWorktree {
  return {
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    gitDir: row.git_dir,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function getProject(db: Database, projectId: string): ProjectRecord | null {
  const row = db
    .query<ProjectRow, [string]>("SELECT * FROM projects WHERE project_id = ?")
    .get(projectId);
  if (!row) return null;
  const worktrees = db
    .query<WorktreeRow, [string]>(
      "SELECT * FROM project_worktrees WHERE project_id = ? ORDER BY worktree_path",
    )
    .all(projectId)
    .map(toWorktree);
  return toRecord(row, worktrees);
}

export function listProjects(db: Database): ProjectRecord[] {
  const rows = db
    .query<ProjectRow, []>("SELECT * FROM projects ORDER BY updated_at DESC, project_id")
    .all();
  const worktrees = db
    .query<WorktreeRow, []>("SELECT * FROM project_worktrees ORDER BY worktree_path")
    .all();
  const grouped = new Map<string, ProjectWorktree[]>();
  for (const row of worktrees) {
    const list = grouped.get(row.project_id) ?? [];
    list.push(toWorktree(row));
    grouped.set(row.project_id, list);
  }
  return rows.map((row) => toRecord(row, grouped.get(row.project_id) ?? []));
}

function isImportedPlaceholder(record: ProjectRow): boolean {
  return record.common_dir.startsWith("import:") && record.root_path.startsWith("import:");
}

/**
 * 登記或更新專案與 worktree；重複呼叫的結果相同。
 * 同一個 projectId 或 worktree 路徑已經屬於別的專案時要拒絕，
 * 不能讓新的解析結果默默接管既有資料。
 */
export function registerProject(db: Database, context: ProjectContext): ProjectRecord {
  const now = nowIso();
  try {
    withImmediateTransaction(db, () => {
      const existing = db
        .query<ProjectRow, [string]>("SELECT * FROM projects WHERE project_id = ?")
        .get(context.projectId);
      if (
        existing !== null &&
        existing.common_dir !== context.commonDir &&
        !isImportedPlaceholder(existing)
      ) {
        throw new SmileworkError(
          ERROR_CODES.projectIdConflict,
          `專案識別碼 ${context.projectId} 已經登記到不同位置：${existing.root_path}`,
          "確認路徑是否正確；如果是專案搬移，改用 smilework project relink。",
          {
            projectId: context.projectId,
            existingCommonDir: existing.common_dir,
            existingRootPath: existing.root_path,
            requestedCommonDir: context.commonDir,
          },
        );
      }

      const existingWorktree = db
        .query<{ project_id: string }, [string]>(
          "SELECT project_id FROM project_worktrees WHERE worktree_path = ?",
        )
        .get(context.worktreePath);
      if (existingWorktree !== null && existingWorktree.project_id !== context.projectId) {
        throw new SmileworkError(
          ERROR_CODES.projectIdConflict,
          `路徑已經登記到另一個專案：${context.worktreePath}`,
          "確認路徑是否正確；如果是專案搬移，改用 smilework project relink。",
          {
            worktreePath: context.worktreePath,
            existingProjectId: existingWorktree.project_id,
            requestedProjectId: context.projectId,
          },
        );
      }

      db.query(
        `INSERT INTO projects (project_id, common_dir, root_path, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           common_dir = excluded.common_dir,
           root_path = CASE
             WHEN projects.root_path LIKE 'import:%' AND excluded.root_path NOT LIKE 'import:%'
             THEN excluded.root_path
             ELSE projects.root_path
           END,
           updated_at = excluded.updated_at,
           last_seen_at = excluded.last_seen_at`,
      ).run(
        context.projectId,
        context.commonDir,
        context.rootPath,
        now,
        now,
        now,
      );

      db.query(
        `INSERT INTO project_worktrees (project_id, worktree_path, git_dir, created_at, last_seen_at)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(worktree_path) DO UPDATE SET
           project_id = excluded.project_id,
           last_seen_at = excluded.last_seen_at`,
      ).run(context.projectId, context.worktreePath, now, now);
    });
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: projects.common_dir")) {
      throw new SmileworkError(
        ERROR_CODES.projectIdConflict,
        `同一個 common dir 已經登記到其他專案：${context.commonDir}`,
        "先執行 smilework project list 確認既有專案，再決定要保留哪一筆。",
        { commonDir: context.commonDir },
      );
    }
    throw error;
  }

  const record = getProject(db, context.projectId);
  if (!record) {
    throw new SmileworkError(
      ERROR_CODES.internal,
      `專案登記後找不到資料：${context.projectId}`,
      "回報這個問題，並附上資料庫與專案路徑。",
      { projectId: context.projectId },
    );
  }
  return record;
}

/** 用 projectId、舊路徑或 worktree 路徑找專案。 */
export function findProjectByPath(db: Database, path: string): ProjectRecord | null {
  const absolute = canonicalizePath(path);
  const row = db
    .query<{ project_id: string }, [string, string, string]>(
      `SELECT p.project_id AS project_id
       FROM projects p
       LEFT JOIN project_worktrees w ON w.project_id = p.project_id
       WHERE p.root_path = ? OR p.common_dir = ? OR w.worktree_path = ?
       LIMIT 1`,
    )
    .get(absolute, absolute, absolute);
  return row ? getProject(db, row.project_id) : null;
}

export interface RelinkProjectOptions {
  newPath: string;
  projectId?: string;
  fromPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RelinkProjectResult {
  previousProjectId: string;
  projectId: string;
  commonDir: string;
  worktreePath: string;
}

/**
 * 找出這次 relink 要更換的舊 worktree 路徑。
 * - --from：以 canonical path 比對，/var 與 /private/var 會視為同一個位置。
 * - 搬移 main：common dir 改變，舊路徑就是 previous.rootPath。
 * - 同 repo 內搬移 linked worktree：從已登記但已不存在的 worktree 中找唯一一個；
 *   無法判斷時要求使用者補 --from，避免誤改 main 的紀錄。
 */
function determineOldWorktreePath(
  previous: ProjectRecord,
  next: ProjectContext,
  fromPath: string | undefined,
): string {
  if (fromPath) return canonicalizePath(fromPath);
  if (next.projectId !== previous.projectId) {
    // 匯入專案的 root_path 是 import:<id> 佔位字串，真正的舊路徑在 worktrees。
    if (!previous.rootPath.startsWith("import:")) return previous.rootPath;
    const missing = previous.worktrees.filter((worktree) => !existsSync(worktree.worktreePath));
    if (missing.length === 1) return missing[0]!.worktreePath;
    if (previous.worktrees.length === 1) return previous.worktrees[0]!.worktreePath;
    return previous.rootPath;
  }
  if (next.worktreePath === previous.rootPath) return previous.rootPath;

  const missing = previous.worktrees.filter((worktree) => !existsSync(worktree.worktreePath));
  if (missing.length === 1) return missing[0]!.worktreePath;

  throw new SmileworkError(
    ERROR_CODES.missingProjectReference,
    "同一個 repo 內搬移 linked worktree 時，無法判斷舊路徑。",
    "改用 smilework project relink <新路徑> --from <舊 worktree 路徑>。",
    { projectId: previous.projectId, newPath: next.worktreePath },
  );
}

/**
 * 把既有專案重新對應到搬移後的位置。projectId 是 common dir 的雜湊，
 * 搬移後會改變；更新 projects 主鍵時，其他資料表靠 ON UPDATE CASCADE 一起更新。
 */
export function relinkProject(db: Database, options: RelinkProjectOptions): RelinkProjectResult {
  if (!options.projectId && !options.fromPath) {
    throw new SmileworkError(
      ERROR_CODES.missingProjectReference,
      "relink 需要 --id 或 --from 指出要更新哪一個專案。",
      "用 smilework project list 找到 projectId，再執行 smilework project relink <新路徑> --id <projectId>；或提供 --from <舊路徑>。",
    );
  }

  const next = resolveProject({
    explicitPath: options.newPath,
    env: options.env,
    cwd: options.cwd,
  } satisfies ResolveProjectOptions);

  let previous: ProjectRecord | null = null;
  if (options.projectId) {
    previous = getProject(db, options.projectId);
  } else if (options.fromPath) {
    previous = findProjectByPath(db, options.fromPath);
  }
  if (!previous) {
    throw new SmileworkError(
      ERROR_CODES.projectNotFound,
      "找不到要重新對應的專案。",
      "先執行 smilework project list 確認專案是否存在，再帶正確的 --id 或 --from。",
      { projectId: options.projectId, fromPath: options.fromPath },
    );
  }

  if (options.projectId && options.fromPath) {
    const byPath = findProjectByPath(db, options.fromPath);
    if (!byPath || byPath.projectId !== previous.projectId) {
      throw new SmileworkError(
        ERROR_CODES.invalidInput,
        "--id 與 --from 指向不同的專案。",
        "只保留其中一個參數，或改用相同的專案。",
        { projectId: options.projectId, fromPath: options.fromPath },
      );
    }
  }

  if (next.projectId !== previous.projectId) {
    const conflict = getProject(db, next.projectId);
    if (conflict) {
      throw new SmileworkError(
        ERROR_CODES.projectIdConflict,
        `新位置已經登記成另一個專案：${next.projectId}`,
        "確認新路徑是否正確，或先移除重複的專案紀錄。",
        { projectId: next.projectId, existingCommonDir: conflict.commonDir },
      );
    }
  }

  const oldWorktreePath = determineOldWorktreePath(previous, next, options.fromPath);
  const now = nowIso();

  withImmediateTransaction(db, () => {
    db.query(
      `UPDATE projects
       SET project_id = ?, common_dir = ?, root_path = ?, updated_at = ?, last_seen_at = ?
       WHERE project_id = ?`,
    ).run(
      next.projectId,
      next.commonDir,
      next.rootPath,
      now,
      now,
      previous.projectId,
    );

    db.query(
      `UPDATE project_worktrees
       SET worktree_path = ?, last_seen_at = ?
       WHERE project_id = ? AND worktree_path = ?`,
    ).run(next.worktreePath, now, next.projectId, oldWorktreePath);

    db.query(
      `INSERT INTO project_worktrees (project_id, worktree_path, git_dir, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(worktree_path) DO UPDATE SET
         project_id = excluded.project_id,
         last_seen_at = excluded.last_seen_at`,
    ).run(next.projectId, next.worktreePath, now, now);

    // 這兩張表沒有專案外鍵，relink 時要自己搬，避免重送與稽核紀錄留在舊識別碼。
    db.query("UPDATE idempotency_keys SET project_id = ? WHERE project_id = ?").run(
      next.projectId,
      previous.projectId,
    );
    db.query("UPDATE usage_events SET project_id = ? WHERE project_id = ?").run(
      next.projectId,
      previous.projectId,
    );

    // id_mappings 沒有專案外鍵；source_root 與 source_id 的專案前綴都要一起換。
    // PK 是 (entity, layer, source_id)，衝突時整筆交易回滾，不能靜默跳過。
    if (next.projectId !== previous.projectId) {
      const oldPrefix = `${previous.projectId}\u0000`;
      const newPrefix = `${next.projectId}\u0000`;
      const mappings = db
        .query<{ entity: string; layer: string; source_id: string }, [string]>(
          "SELECT entity, layer, source_id FROM id_mappings WHERE source_root = ?",
        )
        .all(previous.projectId);
      const planned = mappings.map((mapping) => ({
        ...mapping,
        nextSourceId: mapping.source_id.startsWith(oldPrefix)
          ? `${newPrefix}${mapping.source_id.slice(oldPrefix.length)}`
          : mapping.source_id,
      }));

      const plannedKeys = new Set<string>();
      for (const mapping of planned) {
        const key = `${mapping.entity}\u0000${mapping.layer}\u0000${mapping.nextSourceId}`;
        if (plannedKeys.has(key)) {
          throw new SmileworkError(
            "ID_MAPPING_CONFLICT",
            `重新對應專案時 id_mappings 主鍵衝突：${mapping.entity}/${mapping.layer}/${mapping.nextSourceId}`,
            "先整理重複的匯入對應，或保留舊 projectId 後再試。",
            { entity: mapping.entity, layer: mapping.layer, sourceId: mapping.nextSourceId },
          );
        }
        plannedKeys.add(key);
      }

      for (const mapping of planned) {
        if (mapping.nextSourceId === mapping.source_id) continue;
        const conflict = db
          .query<{ source_root: string }, [string, string, string]>(
            "SELECT source_root FROM id_mappings WHERE entity = ? AND layer = ? AND source_id = ?",
          )
          .get(mapping.entity, mapping.layer, mapping.nextSourceId);
        if (conflict !== null) {
          throw new SmileworkError(
            "ID_MAPPING_CONFLICT",
            `重新對應專案時 id_mappings 主鍵衝突：${mapping.entity}/${mapping.layer}/${mapping.nextSourceId}`,
            "先整理重複的匯入對應，或保留舊 projectId 後再試。",
            {
              entity: mapping.entity,
              layer: mapping.layer,
              sourceId: mapping.nextSourceId,
              existingSourceRoot: conflict.source_root,
            },
          );
        }
      }

      for (const mapping of planned) {
        try {
          db.query(
            `UPDATE id_mappings
                SET source_root = ?, source_id = ?
              WHERE entity = ? AND layer = ? AND source_id = ?`,
          ).run(
            next.projectId,
            mapping.nextSourceId,
            mapping.entity,
            mapping.layer,
            mapping.source_id,
          );
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed: id_mappings")) {
            throw new SmileworkError(
              "ID_MAPPING_CONFLICT",
              `重新對應專案時 id_mappings 主鍵衝突：${mapping.entity}/${mapping.layer}/${mapping.nextSourceId}`,
              "先整理重複的匯入對應，或保留舊 projectId 後再試。",
              {
                entity: mapping.entity,
                layer: mapping.layer,
                sourceId: mapping.nextSourceId,
              },
            );
          }
          throw error;
        }
      }
    }
  });

  return {
    previousProjectId: previous.projectId,
    projectId: next.projectId,
    commonDir: next.commonDir,
    worktreePath: next.worktreePath,
  };
}
