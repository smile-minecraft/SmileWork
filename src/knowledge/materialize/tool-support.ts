import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ProjectContext } from "../../domain/project.ts";
import { withImmediateTransaction } from "../../db/transaction.ts";
import { isProjectResolutionError } from "../../mcp/context.ts";
import type { ToolContext } from "../../mcp/types.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { sha256Hex } from "../../shared/hash.ts";
import { nowIso } from "../../shared/time.ts";
import { KNOWLEDGE_TOOL_ERROR_CODES } from "./errors.ts";

/** 寫入類知識工具都需要可解析的專案；解析失敗一律回 PROJECT_UNRESOLVED。 */
export function requireKnowledgeProject(
  context: ToolContext,
  explicitPath?: string,
): ProjectContext {
  try {
    return context.resolveProject(explicitPath);
  } catch (error) {
    if (!isProjectResolutionError(error)) throw error;
    const cause = error instanceof SmileworkError ? error : null;
    throw new SmileworkError(
      KNOWLEDGE_TOOL_ERROR_CODES.projectUnresolved,
      `無法解析知識所屬專案：${error instanceof Error ? error.message : String(error)}`,
      "設定 SMILEWORK_PROJECT、在 git repo 內執行，或在參數提供 projectPath；全域知識請設定 layer=global。",
      { causeCode: cause?.code ?? null, path: cause?.data.path ?? null },
    );
  }
}

/** 全域技能要檢查目前專案的跨層同名；解析不到專案時退回比對所有專案。 */
export function optionalKnowledgeProject(
  context: ToolContext,
  explicitPath?: string,
): ProjectContext | null {
  try {
    return context.tryResolveProject(explicitPath);
  } catch (error) {
    if (isProjectResolutionError(error)) return null;
    throw error;
  }
}

export function knowledgeStoreOptions(smileworkHome: string): { storeRoot: string } {
  return { storeRoot: join(smileworkHome, "knowledge-store") };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function knowledgeRequestHash(request: unknown): string {
  return sha256Hex(canonicalJson(request));
}

interface IdempotencyRow {
  request_hash: string;
  response: string;
}

export interface KnowledgeIdempotencyOptions {
  projectKey: string;
  key: string | undefined;
  request: unknown;
  tool: string;
}

export interface KnowledgeIdempotentResult<T> {
  value: T;
  replay: boolean;
}

/** 在跑檢查與寫入前先看冪等鍵；重送不應因為後續環境改變而重新驗證失敗。 */
export function readKnowledgeIdempotentReplay<T>(
  db: Database,
  options: KnowledgeIdempotencyOptions,
): T | null {
  if (options.key === undefined) return null;
  const requestHash = knowledgeRequestHash(options.request);
  const existing = db
    .query<IdempotencyRow, [string, string, string]>(
      `SELECT request_hash, response FROM idempotency_keys
       WHERE project_id = ? AND tool = ? AND key = ?`,
    )
    .get(options.projectKey, options.tool, options.key);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    throw new SmileworkError(
      KNOWLEDGE_TOOL_ERROR_CODES.idempotencyConflict,
      `idempotencyKey 已經用在不同的請求內容：${options.key}`,
      "換一個 idempotencyKey，或先用原本的請求內容重送。",
      { key: options.key },
    );
  }
  return JSON.parse(existing.response) as T;
}

/**
 * 同一個 idempotencyKey 只執行一次；重送回傳第一次的成功結果。
 * `run` 內的資料庫寫入會和外層交易一起提交或回滾。
 */
export function runKnowledgeIdempotent<T>(
  db: Database,
  options: KnowledgeIdempotencyOptions,
  run: () => T,
): KnowledgeIdempotentResult<T> {
  return withImmediateTransaction(db, () => {
    if (options.key === undefined) return { value: run(), replay: false };

    const requestHash = knowledgeRequestHash(options.request);
    const existing = db
      .query<IdempotencyRow, [string, string, string]>(
        `SELECT request_hash, response FROM idempotency_keys
         WHERE project_id = ? AND tool = ? AND key = ?`,
      )
      .get(options.projectKey, options.tool, options.key);

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new SmileworkError(
          KNOWLEDGE_TOOL_ERROR_CODES.idempotencyConflict,
          `idempotencyKey 已經用在不同的請求內容：${options.key}`,
          "換一個 idempotencyKey，或先用原本的請求內容重送。",
          { key: options.key },
        );
      }
      return { value: JSON.parse(existing.response) as T, replay: true };
    }

    const value = run();
    db.query(
      `INSERT INTO idempotency_keys (project_id, tool, key, request_hash, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      options.projectKey,
      options.tool,
      options.key,
      requestHash,
      JSON.stringify(value),
      nowIso(),
    );
    return { value, replay: false };
  });
}
