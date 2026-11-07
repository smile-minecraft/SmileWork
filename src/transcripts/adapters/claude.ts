import type { ParseResult, ParsedEntry } from "../types.ts";
import {
  asRecord,
  asString,
  contentToText,
  currentTurn,
  makeEntry,
  normalizeTimestamp,
  setProjectPath,
  setSessionRef,
  startTurn,
  valueToText,
  type LineState,
} from "./shared.ts";

/** 這些紀錄不是對話內容，跳過不記警告。 */
const SKIPPED_TYPES = new Set([
  "summary",
  "system",
  "file-history-snapshot",
  "queue-operation",
  "progress",
]);

export function parseClaudeRecord(record: Record<string, unknown>, state: LineState): ParseResult {
  const type = asString(record.type);
  if (record.isMeta === true) return { entries: [] };
  if (type && SKIPPED_TYPES.has(type)) return { entries: [] };

  setProjectPath(state, record.cwd);
  setSessionRef(state, "claude", asString(record.sessionId));
  const at = normalizeTimestamp(record.timestamp);

  if (type === "user") return parseUserRecord(record, state, at);
  if (type === "assistant") return parseAssistantRecord(record, state, at);

  return {
    entries: [],
    warning: `Claude Code 紀錄類型無法辨識：${type ?? "(缺少 type)"}`,
  };
}

function parseUserRecord(
  record: Record<string, unknown>,
  state: LineState,
  at: string | undefined,
): ParseResult {
  const message = asRecord(record.message);
  if (!message) return { entries: [], warning: "Claude Code user 紀錄缺少 message" };

  const content = message.content;
  const originSeq = state.nextSeq++;
  const entries: ParsedEntry[] = [];

  if (!Array.isArray(content)) {
    const text = contentToText(content);
    if (text) {
      if (asString(message.role) === "user") startTurn(state);
      entries.push(makeEntry(state, originSeq, 0, "user", text, undefined, at));
    }
    return { entries };
  }

  const textBlocks: string[] = [];
  const toolResults: Record<string, unknown>[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    const blockType = asString(block.type);
    if (blockType === "tool_result") {
      toolResults.push(block);
    } else if (
      blockType === "text" ||
      blockType === "input_text" ||
      blockType === "output_text" ||
      blockType === undefined
    ) {
      const text = contentToText([block]);
      if (text) textBlocks.push(text);
    }
  }

  let blockIndex = 0;
  if (textBlocks.length > 0) {
    const turnText = textBlocks.join("\n");
    startTurn(state);
    entries.push(makeEntry(state, originSeq, blockIndex++, "user", turnText, undefined, at));
  }

  if (toolResults.length > 0 && state.turn === 0) state.turn = 1;
  for (const result of toolResults) {
    const toolUseId = asString(result.tool_use_id);
    const toolName = toolUseId ? state.toolNames[toolUseId] : undefined;
    const text = contentToText(result.content) || valueToText(result.content);
    if (!text) continue;
    entries.push(makeEntry(state, originSeq, blockIndex++, "tool", text, toolName, at));
  }

  return { entries };
}

function parseAssistantRecord(
  record: Record<string, unknown>,
  state: LineState,
  at: string | undefined,
): ParseResult {
  const message = asRecord(record.message);
  if (!message) return { entries: [], warning: "Claude Code assistant 紀錄缺少 message" };

  const content = message.content;
  const originSeq = state.nextSeq++;
  const turn = currentTurn(state);
  const entries: ParsedEntry[] = [];

  if (!Array.isArray(content)) {
    const text = contentToText(content);
    if (text) entries.push(makeEntry(state, originSeq, 0, "assistant", text, undefined, at));
    return { entries };
  }

  let blockIndex = 0;
  let pendingText: string[] = [];

  const flushText = (): void => {
    if (pendingText.length === 0) return;
    entries.push(
      makeEntry(state, originSeq, blockIndex++, "assistant", pendingText.join("\n"), undefined, at),
    );
    pendingText = [];
  };

  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    const blockType = asString(block.type);
    if (blockType === "text") {
      const text = contentToText([block]);
      if (text) pendingText.push(text);
      continue;
    }
    if (blockType === "tool_use") {
      flushText();
      const toolName = asString(block.name);
      const toolUseId = asString(block.id);
      if (toolUseId && toolName) state.toolNames[toolUseId] = toolName;
      const text = valueToText(block.input);
      if (text) {
        entries.push(makeEntry(state, originSeq, blockIndex++, "tool", text, toolName, at));
      }
      continue;
    }
    // thinking、image 等其他區塊不是可搜尋的文字。
  }
  flushText();

  return { entries };
}
