import type { Resolution, WorkStatus } from "./types.ts";

export interface MappedStatus {
  status: WorkStatus;
  resolution?: Resolution;
}

/**
 * 舊版 ultrawork v3 狀態 → 匯出格式 v1 狀態。
 * 對照 `docs/export-format-v1.md` 與計畫的狀態表；表上沒有的值回 undefined，
 * 呼叫端要放進 raw/ 並記警告，不能猜。
 */
export function mapLegacyStatus(state: string): MappedStatus | undefined {
  switch (state.trim().toUpperCase()) {
    case "NEW":
    case "DRAFT":
    case "CLARIFYING":
    case "PLANNED":
      return { status: "open" };
    case "IN_PROGRESS":
    case "ACTIVE":
      return { status: "in_progress" };
    case "BLOCKED":
      return { status: "blocked" };
    case "REVIEWING":
    case "ARCHIVING":
      return { status: "review" };
    case "COMPLETED":
    case "DONE":
      return { status: "done", resolution: "completed" };
    case "FAILED":
      return { status: "done", resolution: "failed" };
    case "CANCELLED":
      return { status: "cancelled", resolution: "abandoned" };
    default:
      return undefined;
  }
}
