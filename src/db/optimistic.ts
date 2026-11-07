import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./transaction.ts";

export interface UpdateVersionedRowOptions {
  table: string;
  idColumn: string;
  id: string;
  expectedVersion: number;
  values: Record<string, string | number | boolean | null>;
  versionColumn?: string;
  updatedAtColumn?: string;
  updatedAt?: string;
}

export interface UpdateVersionedRowResult {
  updated: boolean;
  currentVersion: number | null;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`不安全的 SQL 識別字：${value}`);
  }
  return value;
}

/**
 * 以 expectedVersion 做樂觀鎖更新。整個讀取與更新在同一筆 BEGIN IMMEDIATE
 * 交易內完成，多個程序同時呼叫時只有版本相符的那一個會成功。
 */
export function updateVersionedRow(
  db: Database,
  options: UpdateVersionedRowOptions,
): UpdateVersionedRowResult {
  const table = assertIdentifier(options.table);
  const idColumn = assertIdentifier(options.idColumn);
  const versionColumn = assertIdentifier(options.versionColumn ?? "version");
  const updatedAtColumn =
    options.updatedAtColumn === undefined ? null : assertIdentifier(options.updatedAtColumn);

  const entries = Object.entries(options.values);
  const assignments = entries.map(([column]) => `${assertIdentifier(column)} = ?`);

  return withImmediateTransaction(db, () => {
    const current = db
      .query<{ version: number }, [string]>(
        `SELECT ${versionColumn} AS version FROM ${table} WHERE ${idColumn} = ?`,
      )
      .get(options.id);

    if (!current) return { updated: false, currentVersion: null };
    if (current.version !== options.expectedVersion) {
      return { updated: false, currentVersion: current.version };
    }

    const setClauses = [...assignments, `${versionColumn} = ${versionColumn} + 1`];
    if (updatedAtColumn) {
      setClauses.push(`${updatedAtColumn} = ?`);
    }

    const params: Array<string | number | null> = entries.map(([, value]) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
    if (updatedAtColumn) {
      params.push(options.updatedAt ?? new Date().toISOString());
    }
    params.push(options.id, options.expectedVersion);

    const result = db
      .query(
        `UPDATE ${table} SET ${setClauses.join(", ")}
         WHERE ${idColumn} = ? AND ${versionColumn} = ?`,
      )
      .run(...params);

    if (result.changes === 0) {
      const latest = db
        .query<{ version: number }, [string]>(
          `SELECT ${versionColumn} AS version FROM ${table} WHERE ${idColumn} = ?`,
        )
        .get(options.id);
      return { updated: false, currentVersion: latest?.version ?? null };
    }

    return { updated: true, currentVersion: options.expectedVersion + 1 };
  });
}
