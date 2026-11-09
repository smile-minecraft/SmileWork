import type { Database } from "bun:sqlite";
import { ERROR_CODES, SmileworkError } from "../shared/errors.ts";
import { parseStoredObject } from "../shared/stored-json.ts";

/** 一份交接紀錄：目前狀態、做過的決定、下一步、還沒驗證的事。 */
export interface WorkHandoff {
  currentState: string;
  decisions: string[];
  nextSteps: string[];
  unverified: string[];
  actor: string;
  actorModel: string | null;
  createdAt: string;
}

/** 執行中自己做的判斷；錯了的代價也要留下，審查時才能一起看。 */
export interface WorkRuling {
  decision: string;
  rationale: string;
  costIfWrong: string | null;
  actor: string;
  actorModel: string | null;
  createdAt: string;
}

export interface WorkContinuity {
  handoff: WorkHandoff | null;
  rulings: WorkRuling[];
}

interface ContinuityEventRow {
  kind: string;
  sequence: number;
  actor: string;
  actor_model: string | null;
  details: string | null;
  created_at: string;
}

function corrupted(workId: string, field: string): SmileworkError {
  return new SmileworkError(
    ERROR_CODES.internal,
    `工作 ${workId} 的 ${field} 不是預期的格式。`,
    "回報這個問題，並附上工作 ID 與資料庫路徑。",
    { entity: "工作", id: workId, field },
  );
}

function stringArray(value: unknown, workId: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw corrupted(workId, field);
  }
  return value;
}

function requiredString(value: unknown, workId: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw corrupted(workId, field);
  return value.trim();
}

function optionalString(value: unknown, workId: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw corrupted(workId, field);
  return value.trim() === "" ? null : value.trim();
}

/**
 * 讀取工作最新的交接與所有決定。交接只取最新一筆；決定依發生順序保留，
 * 讓審查者看得到執行過程中的判斷是怎麼累積的。
 */
export function loadWorkContinuity(
  db: Database,
  projectId: string,
  workId: string,
): WorkContinuity {
  const rows = db
    .query<ContinuityEventRow, [string, string]>(
      `SELECT kind, sequence, actor, actor_model, details, created_at
       FROM events
       WHERE project_id = ? AND work_id = ? AND kind IN ('handoff', 'ruling')
       ORDER BY sequence DESC`,
    )
    .all(projectId, workId);

  let handoff: WorkHandoff | null = null;
  const rulings: WorkRuling[] = [];

  for (const row of rows) {
    const details = parseStoredObject(row.details, {
      entity: "工作",
      id: workId,
      field: `events.${row.kind}.details`,
    });
    if (details === null) continue;

    if (row.kind === "handoff") {
      if (handoff !== null) continue;
      handoff = {
        currentState: requiredString(details.currentState, workId, "handoff.currentState"),
        decisions: stringArray(details.decisions, workId, "handoff.decisions"),
        nextSteps: stringArray(details.nextSteps, workId, "handoff.nextSteps"),
        unverified: stringArray(details.unverified, workId, "handoff.unverified"),
        actor: row.actor,
        actorModel: row.actor_model,
        createdAt: row.created_at,
      };
      continue;
    }

    rulings.push({
      decision: requiredString(details.decision, workId, "ruling.decision"),
      rationale: requiredString(details.rationale, workId, "ruling.rationale"),
      costIfWrong: optionalString(details.costIfWrong, workId, "ruling.costIfWrong"),
      actor: row.actor,
      actorModel: row.actor_model,
      createdAt: row.created_at,
    });
  }

  rulings.reverse();
  return { handoff, rulings };
}

/** 把交接與決定排成 brief 的段落；沒有資料時回空陣列。 */
export function renderContinuitySections(continuity: WorkContinuity): string[] {
  const lines: string[] = [];
  const { handoff } = continuity;
  if (handoff) {
    lines.push("", "## 交接紀錄", "");
    lines.push(`- 目前狀態：${handoff.currentState}`);
    lines.push(`- 留下時間：${handoff.createdAt}（${handoff.actor}${handoff.actorModel ? `／${handoff.actorModel}` : ""}）`);
    for (const section of [
      ["做過的決定", handoff.decisions],
      ["下一步", handoff.nextSteps],
      ["還沒驗證", handoff.unverified],
    ] as const) {
      if (section[1].length > 0) {
        lines.push(`- ${section[0]}：`);
        for (const item of section[1]) lines.push(`  - ${item}`);
      }
    }
  }

  if (continuity.rulings.length > 0) {
    lines.push("", "## 決定紀錄", "");
    for (const ruling of continuity.rulings) {
      lines.push(
        `- 決定：${ruling.decision}`,
        `  理由：${ruling.rationale}`,
      );
      if (ruling.costIfWrong !== null) lines.push(`  錯了會怎樣：${ruling.costIfWrong}`);
    }
  }

  return lines;
}
