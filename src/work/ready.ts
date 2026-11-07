import type { Database } from "bun:sqlite";
import type { WorkView } from "./crud.ts";
import { loadWorkViews } from "./crud.ts";

export interface ListReadyWorksInput {
  parentId?: string;
  limit: number;
}

/**
 * 可開始的工作是狀態 open、而且所有依賴都已 done 的項目。
 * 依賴被取消時仍然阻擋，因為取消不代表完成。
 */
export function listReadyWorks(
  db: Database,
  projectId: string,
  input: ListReadyWorksInput,
): WorkView[] {
  const clauses: string[] = ["w.project_id = ?", "w.status = 'open'"];
  const params: Array<string | number> = [projectId];

  if (input.parentId !== undefined) {
    clauses.push("w.plan_id = ?");
    params.push(input.parentId);
  }

  clauses.push(
    `NOT EXISTS (
       SELECT 1
       FROM work_dependencies d
       JOIN work_items dependency ON dependency.work_id = d.depends_on_work_id
       WHERE d.work_id = w.work_id AND dependency.status <> 'done'
     )`,
  );
  const where = clauses.join(" AND ");
  params.push(input.limit);

  const rows = db
    .query<{ work_id: string }, Array<string | number>>(
      `SELECT w.work_id FROM work_items w
       WHERE ${where}
       ORDER BY w.created_at ASC, w.work_id ASC
       LIMIT ?`,
    )
    .all(...params);

  return loadWorkViews(
    db,
    rows.map((row) => row.work_id),
  );
}
