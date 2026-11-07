import type { Database } from "bun:sqlite";

/**
 * 在單一寫入交易中執行函式。SQLite 的 BEGIN IMMEDIATE 會先取得寫入鎖，
 * 避免兩個程序同時把讀取鎖升級成寫入鎖而卡死。
 */
export function withImmediateTransaction<T>(db: Database, run: () => T): T {
  if (db.inTransaction) return run();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 保留原始錯誤，rollback 失敗只表示交易已經結束。
    }
    throw error;
  }
}
