import type { Database } from "bun:sqlite";
import { getWorkDetail, type WorkDetail } from "../work/crud.ts";

interface WorkProjectRow {
  project_id: string;
}

/** 工作識別碼在資料庫中是主鍵，resource 不必先解析目前專案。 */
export function loadWorkDetailById(db: Database, workId: string): WorkDetail | null {
  const row = db
    .query<WorkProjectRow, [string]>("SELECT project_id FROM work_items WHERE work_id = ?")
    .get(workId);
  if (!row) return null;
  return getWorkDetail(db, row.project_id, workId);
}

/** 派工說明加上證據清單，讓單一工作 resource 可以獨立閱讀。 */
export function renderWork(detail: WorkDetail): string {
  const lines = [detail.brief, "", `## 證據（${detail.evidence.length}）`, ""];
  if (detail.evidence.length === 0) {
    lines.push("目前沒有證據。");
    return lines.join("\n");
  }
  for (const item of detail.evidence) {
    const target = item.command ?? item.url ?? item.path ?? "";
    lines.push(`- [${item.kind}] ${item.summary}${target ? `（${target}）` : ""}`);
  }
  return lines.join("\n");
}
