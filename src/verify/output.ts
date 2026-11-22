/**
 * verify_run 回應的精簡輸出：完整輸出已寫進證據檔，回應只帶尾端與錯誤重點，
 * 避免把數十 KB 的日誌塞進代理的上下文。
 */

export const RESPONSE_STREAM_TAIL_BYTES = 2048;
export const OUTPUT_TAIL_LINES = 40;
export const OUTPUT_TAIL_BYTES = 4096;
export const MAX_ERROR_HIGHLIGHTS = 20;
const MAX_HIGHLIGHT_LENGTH = 300;

const ERROR_LINE_PATTERN =
  /\bFAIL(?:ED|URE)?\b|\bERROR\b|\bAssertionError\b|\berror(?:\[[\w-]+\])?:|\bError:|Exception\b|\bpanicked\b|\(fail\)|✗|✘/;

export interface CompactVerificationOutput {
  stdout: string;
  stderr: string;
  /** stdout 或 stderr 在回應中被截成尾端時為 true；完整內容見 outputPath。 */
  responseTruncated: boolean;
  outputTail: string;
  errorHighlights: string[];
}

/** 取 UTF-8 尾端最多 maxBytes 位元組，不切壞多位元組字元。 */
export function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let start = buffer.length - maxBytes;
  // 跳過 UTF-8 的延續位元組（10xxxxxx），從完整字元開始。
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return { text: buffer.subarray(start).toString("utf8"), truncated: true };
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export function buildOutputTail(stdout: string, stderr: string): string {
  const lines = [...nonEmptyLines(stdout), ...nonEmptyLines(stderr)].slice(-OUTPUT_TAIL_LINES);
  return tailBytes(lines.join("\n"), OUTPUT_TAIL_BYTES).text;
}

export function extractErrorHighlights(stdout: string, stderr: string): string[] {
  const highlights: string[] = [];
  for (const line of [...nonEmptyLines(stdout), ...nonEmptyLines(stderr)]) {
    if (!ERROR_LINE_PATTERN.test(line)) continue;
    const trimmed = line.trim();
    highlights.push(
      trimmed.length > MAX_HIGHLIGHT_LENGTH ? `${trimmed.slice(0, MAX_HIGHLIGHT_LENGTH)}…` : trimmed,
    );
    if (highlights.length >= MAX_ERROR_HIGHLIGHTS) break;
  }
  return highlights;
}

export function compactVerificationOutput(stdout: string, stderr: string): CompactVerificationOutput {
  const out = tailBytes(stdout, RESPONSE_STREAM_TAIL_BYTES);
  const err = tailBytes(stderr, RESPONSE_STREAM_TAIL_BYTES);
  return {
    stdout: out.text,
    stderr: err.text,
    responseTruncated: out.truncated || err.truncated,
    outputTail: buildOutputTail(stdout, stderr),
    errorHighlights: extractErrorHighlights(stdout, stderr),
  };
}
