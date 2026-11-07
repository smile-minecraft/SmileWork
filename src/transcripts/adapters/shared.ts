import { basename, extname } from "node:path";
import type { ParsedEntry, TranscriptRole } from "../types.ts";

/** JSONL adapter 在增量解析之間保存的狀態；會序列化進索引資料庫。 */
export interface LineState {
  sessionRef: string;
  explicitSession: boolean;
  projectPath?: string;
  turn: number;
  nextSeq: number;
  toolNames: Record<string, string>;
}

export function createLineState(source: "claude" | "codex", filePath: string): LineState {
  const stem = basename(filePath, extname(filePath));
  return {
    sessionRef: `${source}:${stem}`,
    explicitSession: false,
    turn: 0,
    nextSeq: 0,
    toolNames: {},
  };
}

export function restoreLineState(
  source: "claude" | "codex",
  filePath: string,
  stored: unknown,
): LineState {
  if (!stored || typeof stored !== "object") return createLineState(source, filePath);
  const record = stored as Record<string, unknown>;
  const toolNames: Record<string, string> = {};
  if (record.toolNames && typeof record.toolNames === "object") {
    for (const [key, value] of Object.entries(record.toolNames as Record<string, unknown>)) {
      if (typeof value === "string") toolNames[key] = value;
    }
  }
  return {
    sessionRef:
      typeof record.sessionRef === "string" && record.sessionRef
        ? record.sessionRef
        : createLineState(source, filePath).sessionRef,
    explicitSession: record.explicitSession === true,
    projectPath: typeof record.projectPath === "string" ? record.projectPath : undefined,
    turn: typeof record.turn === "number" && Number.isFinite(record.turn) ? record.turn : 0,
    nextSeq:
      typeof record.nextSeq === "number" && Number.isFinite(record.nextSeq) ? record.nextSeq : 0,
    toolNames,
  };
}

export function currentTurn(state: LineState): number {
  return state.turn > 0 ? state.turn : 1;
}

export function startTurn(state: LineState): number {
  state.turn += 1;
  return state.turn;
}

export function setSessionRef(
  state: LineState,
  source: "claude" | "codex",
  sessionId: string | undefined,
): void {
  if (!sessionId || state.explicitSession) return;
  state.sessionRef = `${source}:${sessionId}`;
  state.explicitSession = true;
}

export function setProjectPath(state: LineState, value: unknown): void {
  if (typeof value === "string" && value.trim()) state.projectPath = value;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 數字毫秒或 ISO 字串都轉成 UTC ISO；看不懂就回 undefined，不讓壞資料進索引。 */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

/** 工具參數或工具輸出可能是物件，轉成可搜尋的文字。 */
export function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textBlock(block: Record<string, unknown>): string | undefined {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return undefined;
}

/**
 * 取出訊息內容的文字。支援字串、文字區塊與工具結果內容；
 * 不同宿主的欄位名稱（text/input_text/output_text）都在這裡收斂。
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return valueToText(content);
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const block = asRecord(item);
    if (!block) continue;
    const type = asString(block.type);
    if (type === "tool_result") {
      const text = contentToText(block.content);
      if (text) parts.push(text);
      continue;
    }
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      type === "reasoning_text" ||
      type === undefined
    ) {
      const text = textBlock(block);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

export function makeEntry(
  state: LineState,
  originSeq: number,
  blockIndex: number,
  role: TranscriptRole,
  text: string,
  toolName?: string,
  at?: string,
): ParsedEntry {
  return {
    originSeq,
    blockIndex,
    turn: currentTurn(state),
    role,
    text,
    ...(toolName ? { toolName } : {}),
    ...(at ? { at } : {}),
  };
}

