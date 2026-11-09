/**
 * 工具名稱清單的單一來源。
 *
 * profiles 只依賴這份清單，不再依賴 registry；registry 反過來在初始化時
 * 驗證自己的定義與 TOOL_NAMES 的名稱和順序完全一致，避免清單與實作漂移。
 */

export const WORKER_TOOL_NAMES = [
  "work_create",
  "work_get",
  "work_list",
  "work_ready",
  "work_update",
  "work_complete",
  "work_review",
  "verify_run",
  "status",
  "signal_note",
  "knowledge_search",
  "knowledge_read",
] as const;

export const CURATOR_TOOL_NAMES = [
  "signal_note",
  "signal_list",
  "signal_mark",
  "knowledge_search",
  "knowledge_read",
  "knowledge_write",
  "knowledge_retire",
  "knowledge_promote",
  "knowledge_history",
  "knowledge_revert",
  "transcript_search",
  "transcript_read",
  "work_get",
  "work_list",
  "status",
] as const;

/** registry 全部 21 個工具的名稱，順序必須與 TOOL_DEFINITIONS 完全一致。 */
export const TOOL_NAMES: readonly string[] = [
  "work_create",
  "work_get",
  "work_list",
  "work_ready",
  "work_update",
  "work_complete",
  "work_review",
  "verify_run",
  "status",
  "signal_note",
  "signal_list",
  "signal_mark",
  "knowledge_search",
  "knowledge_read",
  "knowledge_write",
  "knowledge_retire",
  "knowledge_promote",
  "knowledge_history",
  "knowledge_revert",
  "transcript_search",
  "transcript_read",
];
