import { describe, expect, test } from "bun:test";
import { createUnifiedDiff } from "../../../src/knowledge/diff.ts";

describe("unified diff", () => {
  test("相同內容沒有差異", () => {
    expect(createUnifiedDiff("第一行\n第二行\n", "第一行\n第二行\n")).toBe("");
  });

  test("新增與刪除行會出現在對應的前綴", () => {
    const diff = createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", {
      oldLabel: "v1",
      newLabel: "v2",
    });
    expect(diff).toContain("--- v1");
    expect(diff).toContain("+++ v2");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" a");
    expect(diff).toContain(" c");
  });

  test("只有新增時也產生 hunk", () => {
    const diff = createUnifiedDiff("", "第一行\n第二行\n");
    expect(diff).toContain("+第一行");
    expect(diff).toContain("+第二行");
  });

  test("相距很遠的變更會分成多個 hunk", () => {
    const oldText = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const newText = oldText.replace("line-2", "line-2-changed").replace("line-29", "line-29-changed");
    const diff = createUnifiedDiff(oldText, newText, { contextLines: 1 });
    expect(diff.match(/^@@/gm)).toHaveLength(2);
  });
});
