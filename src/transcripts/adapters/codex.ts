import type { ParseResult, ParsedEntry } from "../types.ts";
import {
  asRecord,
  asString,
  contentToText,
  makeEntry,
  normalizeTimestamp,
  setProjectPath,
  setSessionRef,
  startTurn,
  valueToText,
  type LineState,
} from "./shared.ts";

/** 不是對話內容的 rollout 紀錄，跳過不記警告。 */
const SKIPPED_TYPES = new Set(["event_msg", "turn_context", "compacted", "ghost_snapshot"]);

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "mcp_tool_call",
]);

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "mcp_tool_call_output",
]);

export function parseCodexRecord(record: Record<string, unknown>, state: LineState): ParseResult {
  const type = asString(record.type);
  if (type && SKIPPED_TYPES.has(type)) return { entries: [] };
  const at = normalizeTimestamp(record.timestamp);

  if (type === "session_meta") {
    const payload = asRecord(record.payload);
    if (!payload) return { entries: [], warning: "Codex session_meta 缺少 payload" };
    const sessionId = asString(payload.id) ?? asString(payload.session_id);
    setSessionRef(state, "codex", sessionId);
    setProjectPath(state, payload.cwd);
    return { entries: [] };
  }

  if (type !== "response_item") {
    return {
      entries: [],
      warning: `Codex rollout 紀錄類型無法辨識：${type ?? "(缺少 type)"}`,
    };
  }

  const payload = asRecord(record.payload);
  if (!payload) return { entries: [], warning: "Codex response_item 缺少 payload" };
  const payloadType = asString(payload.type);
  if (!payloadType) return { entries: [], warning: "Codex response_item 缺少 type" };

  if (payloadType === "message") return parseMessage(payload, state, at);
  if (TOOL_CALL_TYPES.has(payloadType)) return parseToolCall(payloadType, payload, state, at);
  if (TOOL_OUTPUT_TYPES.has(payloadType)) return parseToolOutput(payload, state, at);
  if (payloadType === "reasoning") return { entries: [] };

  return {
    entries: [],
    warning: `Codex response_item 類型無法辨識：${payloadType}`,
  };
}

function parseMessage(
  payload: Record<string, unknown>,
  state: LineState,
  at: string | undefined,
): ParseResult {
  const roleValue = asString(payload.role) ?? "assistant";
  const text = contentToText(payload.content);
  if (!text) return { entries: [] };

  const originSeq = state.nextSeq++;
  if (roleValue === "user") {
    startTurn(state);
    return { entries: [makeEntry(state, originSeq, 0, "user", text, undefined, at)] };
  }
  if (roleValue === "assistant") {
    return {
      entries: [makeEntry(state, originSeq, 0, "assistant", text, undefined, at)],
    };
  }
  const role = "system";
  return { entries: [makeEntry(state, originSeq, 0, role, text, undefined, at)] };
}

function parseToolCall(
  payloadType: string,
  payload: Record<string, unknown>,
  state: LineState,
  at: string | undefined,
): ParseResult {
  const originSeq = state.nextSeq++;
  const toolName =
    asString(payload.name) ??
    (payloadType === "local_shell_call" ? "shell" : undefined) ??
    (payloadType === "web_search_call" ? "web_search" : payloadType);
  const callId = asString(payload.call_id) ?? asString(payload.id);
  if (callId) state.toolNames[callId] = toolName;

  const argumentSource =
    payload.arguments ?? payload.input ?? payload.action ?? payload.query ?? payload;
  const text = valueToText(argumentSource);
  if (!text) return { entries: [] };

  return {
    entries: [makeEntry(state, originSeq, 0, "tool", text, toolName, at)],
  };
}

function parseToolOutput(
  payload: Record<string, unknown>,
  state: LineState,
  at: string | undefined,
): ParseResult {
  const originSeq = state.nextSeq++;
  const callId = asString(payload.call_id) ?? asString(payload.id);
  const toolName = callId ? state.toolNames[callId] : asString(payload.name);
  const text = valueToText(payload.output ?? payload.result ?? payload);
  if (!text) return { entries: [] };

  return {
    entries: [makeEntry(state, originSeq, 0, "tool", text, toolName, at)],
  };
}
