import type { Database } from "bun:sqlite";
import { ResourceNotFoundError } from "@modelcontextprotocol/server";

const STATUS_ORDER = ["open", "in_progress", "blocked", "review", "done", "cancelled"] as const;

interface BoardRow {
  work_id: string;
  title: string;
  status: string;
  owner: string;
  priority: string;
  risk: string | null;
}

interface ProjectRow {
  root_path: string;
}

/** 把專案的工作依狀態排成 Markdown 看板；找不到專案時回 resource 錯誤。 */
export function renderBoard(
  db: Database,
  projectId: string,
  uri: string = `smilework://board/${projectId}`,
): string {
  const project = db
    .query<ProjectRow, [string]>("SELECT root_path FROM projects WHERE project_id = ?")
    .get(projectId);
  if (!project) {
    throw new ResourceNotFoundError(uri, `找不到專案：${projectId}`);
  }

  const rows = db
    .query<BoardRow, [string]>(
      `SELECT work_id, title, status, owner, priority, risk
       FROM work_items
       WHERE project_id = ?
       ORDER BY created_at, work_id`,
    )
    .all(projectId);

  const lines = [
    `# 工作看板 ${projectId}`,
    "",
    `專案路徑：${project.root_path}`,
    "",
    `共 ${rows.length} 筆工作。`,
  ];

  if (rows.length === 0) {
    lines.push("", "目前沒有工作。");
    return lines.join("\n");
  }

  for (const status of STATUS_ORDER) {
    const items = rows.filter((row) => row.status === status);
    if (items.length === 0) continue;
    lines.push("", `## ${status}（${items.length}）`, "");
    for (const item of items) {
      const risk = item.risk === null ? "" : `，risk：${item.risk}`;
      lines.push(
        `- \`${item.work_id}\` ${item.title}（owner：${item.owner}，priority：${item.priority}${risk}）`,
      );
    }
  }

  return lines.join("\n");
}
