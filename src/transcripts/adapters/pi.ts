import { basename, dirname } from "node:path";
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

/** Pi 的狀態與設定紀錄不是對話內容，跳過不記警告。 */
const SKIPPED_TYPES = new Set([
  "model_change",
  "thinking_level_change",
  "custom",
  "compaction",
  "branch",
  "label",
]);

/**
 * Pi 的 session 檔放在 `--<slug>--` 資料夾，slug 是工作目錄去掉開頭斜線、
 * 每個 `/` 換成 `-`。路徑本身有連字號時無法還原，所以只當成 session
 * 紀錄沒有 cwd 時的備援。
 */
export function projectPathFromSlug(filePath: string): string | undefined {
  const slug = basename(dirname(filePath));
  if (slug.length < 4 || !slug.startsWith("--") || !slug.endsWith("--")) return undefined;
  const inner = slug.slice(2, -2);
  return inner === "" ? undefined : `/${inner.replaceAll("-", "/")}`;
}

export function parsePiRecord(record: Record<string, unknown>, state: LineState): ParseResult {
  const type = asString(record.type);

  if (type === "session") {
    setSessionRef(state, "pi", asString(record.id));
    setProjectPath(state, record.cwd);
    return { entries: [] };
  }
  if (type && SKIPPED_TYPES.has(type)) return { entries: [] };
  if (type !== "message") {
    return {
      entries: [],
      warning: `Pi 紀錄類型無法辨識：${type ?? "(缺少 type)"}`,
    };
  }

  const message = asRecord(record.message);
  if (!message) return { entries: [], warning: "Pi message 紀錄缺少 message" };
  const at = normalizeTimestamp(record.timestamp ?? message.timestamp);
  const role = asString(message.role);

  if (role === "user") {
    const text = contentToText(message.content);
    if (!text) return { entries: [] };
    const originSeq = state.nextSeq++;
    startTurn(state);
    return { entries: [makeEntry(state, originSeq, 0, "user", text, undefined, at)] };
  }

  if (role === "assistant") {
    return parseAssistant(message, state, at);
  }

  if (role === "toolResult") {
    const text = contentToText(message.content) || valueToText(message.content);
    if (!text) return { entries: [] };
    const originSeq = state.nextSeq++;
    return {
      entries: [
        makeEntry(
          state,
          originSeq,
          0,
          "tool",
          text,
          asString(message.toolName),
          at,
        ),
      ],
    };
  }

  return { entries: [], warning: `Pi 訊息角色無法辨識：${role ?? "(缺少 role)"}` };
}

function parseAssistant(
  message: Record<string, unknown>,
  state: LineState,
  at: string | undefined,
): ParseResult {
  const content = message.content;
  const originSeq = state.nextSeq++;
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
    if (blockType === "toolCall") {
      flushText();
      const toolName = asString(block.name);
      const text = valueToText(block.arguments);
      if (text) {
        entries.push(makeEntry(state, originSeq, blockIndex++, "tool", text, toolName, at));
      }
    }
    // thinking 等其他區塊不是可搜尋的文字。
  }
  flushText();

  return { entries };
}
