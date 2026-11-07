/**
 * 以行計算 unified diff。知識版本是 Markdown 純文字，diff 只用來顯示
 * 兩版之間新增、刪除與保留的行，不負責套用修補。
 */

export interface UnifiedDiffOptions {
  oldLabel?: string;
  newLabel?: string;
  /** 每個變更前後保留的上下文行數，預設 3。 */
  contextLines?: number;
}

interface DiffOp {
  type: "equal" | "insert" | "delete";
  line: string;
}

interface DiffEntry {
  op: DiffOp;
  oldLine: number | null;
  newLine: number | null;
}

interface Hunk {
  start: number;
  end: number;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * Myers 差異演算法：以最少的編輯步驟找出兩段序列的差異。
 * trace 保存每一個 d 開始前的 V，回溯時就能還原 equal、insert、delete 的順序。
 */
function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  if (oldLength === 0) return newLines.map((line) => ({ type: "insert", line }));
  if (newLength === 0) return oldLines.map((line) => ({ type: "delete", line }));

  const max = oldLength + newLength;
  const offset = max;
  const furthest = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let distance = 0; distance <= max; distance++) {
    trace.push(furthest.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x: number;
      if (
        diagonal === -distance ||
        (diagonal !== distance &&
          furthest[offset + diagonal - 1]! < furthest[offset + diagonal + 1]!)
      ) {
        x = furthest[offset + diagonal + 1]!;
      } else {
        x = furthest[offset + diagonal - 1]! + 1;
      }
      let y = x - diagonal;
      while (x < oldLength && y < newLength && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      furthest[offset + diagonal] = x;
      if (x >= oldLength && y >= newLength) {
        return backtrack(trace, oldLines, newLines, offset);
      }
    }
  }

  throw new Error("無法計算差異。");
}

function backtrack(
  trace: readonly Int32Array[],
  oldLines: readonly string[],
  newLines: readonly string[],
  offset: number,
): DiffOp[] {
  let x = oldLines.length;
  let y = newLines.length;
  const reversed: DiffOp[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const furthest = trace[distance]!;
    const diagonal = x - y;
    let previousDiagonal: number;
    if (
      diagonal === -distance ||
      (diagonal !== distance &&
        furthest[offset + diagonal - 1]! < furthest[offset + diagonal + 1]!)
    ) {
      previousDiagonal = diagonal + 1;
    } else {
      previousDiagonal = diagonal - 1;
    }

    const previousX = furthest[offset + previousDiagonal]!;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      reversed.push({ type: "equal", line: oldLines[x - 1]! });
      x--;
      y--;
    }

    if (distance === 0) break;
    if (x === previousX) {
      reversed.push({ type: "insert", line: newLines[y - 1]! });
      y--;
    } else {
      reversed.push({ type: "delete", line: oldLines[x - 1]! });
      x--;
    }
  }

  return reversed.reverse();
}

function withLineNumbers(ops: readonly DiffOp[]): DiffEntry[] {
  let oldLine = 1;
  let newLine = 1;
  return ops.map((op) => {
    const entry: DiffEntry = {
      op,
      oldLine: op.type === "insert" ? null : oldLine,
      newLine: op.type === "delete" ? null : newLine,
    };
    if (op.type !== "insert") oldLine++;
    if (op.type !== "delete") newLine++;
    return entry;
  });
}

function groupHunks(entries: readonly DiffEntry[], contextLines: number): Hunk[] {
  const hunks: Hunk[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.op.type === "equal") continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(entries.length - 1, index + contextLines);
    const last = hunks.at(-1);
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      hunks.push({ start, end });
    }
  }
  return hunks;
}

function rangeLabel(start: number | null, count: number): string {
  const line = count === 0 ? Math.max(0, (start ?? 1) - 1) : (start ?? 1);
  return `${line},${count}`;
}

function renderHunk(entries: readonly DiffEntry[], hunk: Hunk): string[] {
  const sliced = entries.slice(hunk.start, hunk.end + 1);
  const oldCount = sliced.filter((entry) => entry.op.type !== "insert").length;
  const newCount = sliced.filter((entry) => entry.op.type !== "delete").length;
  const oldStart = sliced.find((entry) => entry.op.type !== "insert")?.oldLine ?? null;
  const newStart = sliced.find((entry) => entry.op.type !== "delete")?.newLine ?? null;
  const lines = [`@@ -${rangeLabel(oldStart, oldCount)} +${rangeLabel(newStart, newCount)} @@`];
  for (const entry of sliced) {
    const prefix = entry.op.type === "equal" ? " " : entry.op.type === "insert" ? "+" : "-";
    lines.push(`${prefix}${entry.op.line}`);
  }
  return lines;
}

/** 產生 unified diff；內容相同時回空字串。 */
export function createUnifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {},
): string {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const entries = withLineNumbers(ops);
  const hunks = groupHunks(entries, Math.max(0, options.contextLines ?? 3));
  if (hunks.length === 0) return "";

  const lines = [`--- ${options.oldLabel ?? "old"}`, `+++ ${options.newLabel ?? "new"}`];
  for (const hunk of hunks) {
    lines.push(...renderHunk(entries, hunk));
  }
  return `${lines.join("\n")}\n`;
}
