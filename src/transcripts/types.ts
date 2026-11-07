/** 對話紀錄的來源。三種格式都不是穩定介面，adapter 讀不懂時只記警告。 */
export const TRANSCRIPT_SOURCES = ["claude", "codex", "opencode"] as const;

export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

export const TRANSCRIPT_ROLES = ["user", "assistant", "tool", "system"] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

/** 三種來源統一後的單一訊息或工具呼叫。 */
export interface TranscriptEntry {
  readonly source: TranscriptSource;
  readonly sessionRef: string;
  readonly projectPath?: string;
  readonly turn: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly toolName?: string;
  readonly at?: string;
}

export interface TranscriptSearchInput {
  readonly query: string;
  readonly source?: TranscriptSource;
  readonly project?: string;
  readonly since?: string;
  readonly limit?: number;
}

export interface TranscriptSearchHit {
  readonly source: TranscriptSource;
  readonly sessionRef: string;
  readonly projectPath?: string;
  readonly turn: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly toolName?: string;
  readonly at?: string;
}

export interface TranscriptIndexState {
  readonly ready: boolean;
  readonly building: boolean;
  readonly started: boolean;
  readonly lastIndexedAt: string | null;
}

export interface TranscriptWarning {
  readonly source: TranscriptSource;
  readonly message: string;
  readonly occurrences: number;
}

export interface TranscriptReadInput {
  readonly sessionRef: string;
  readonly fromTurn?: number;
  readonly maxTurns?: number;
  readonly maxChars?: number;
}

export interface TranscriptReadEntry {
  readonly turn: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly toolName?: string;
  readonly at?: string;
}

/** 每一列索引資料在來源內的排序位置；同一個訊息的工具呼叫用 blockIndex 區分。 */
export interface ParsedEntry {
  readonly originSeq: number;
  readonly blockIndex: number;
  readonly turn: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly toolName?: string;
  readonly at?: string;
}

export interface ParseResult {
  readonly entries: readonly ParsedEntry[];
  readonly warning?: string;
}

export function isTranscriptSource(value: unknown): value is TranscriptSource {
  return typeof value === "string" && (TRANSCRIPT_SOURCES as readonly string[]).includes(value);
}

export function isTranscriptRole(value: unknown): value is TranscriptRole {
  return typeof value === "string" && (TRANSCRIPT_ROLES as readonly string[]).includes(value);
}
