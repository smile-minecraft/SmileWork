import { describe, expect, test } from "bun:test";
import { knowledgeRequestHash } from "../../src/knowledge/materialize/tool-support.ts";
import { canonicalJson } from "../../src/shared/canonical.ts";

describe("共用的 canonicalJson", () => {
  test("物件的鍵依 localeCompare 排序，插入順序不影響輸出", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  test("陣列保持原本的順序", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test("物件中值為 undefined 的鍵會被略過", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: null })).toBe('{"a":1,"c":null}');
    expect(canonicalJson({ nested: { a: undefined, b: 2 } })).toBe('{"nested":{"b":2}}');
  });

  test("非 ASCII 鍵維持目前的 localeCompare 排序", () => {
    expect(canonicalJson({ 中: 3, é: 2, ä: 1, a: 0, Z: 9, B: 8 })).toBe(
      '{"a":0,"ä":1,"B":8,"é":2,"Z":9,"中":3}',
    );
  });

  test("null 與基本值沿用 JSON.stringify", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("文字")).toBe('"文字"');
    expect(canonicalJson(42)).toBe("42");
  });

  test("knowledgeRequestHash 對同一份請求的不同鍵順序給出相同雜湊", () => {
    const request = {
      tool: "knowledge_write",
      title: "測試",
      tags: ["b", "a"],
      idempotencyKey: "k",
    };
    const reordered = {
      idempotencyKey: "k",
      tags: ["b", "a"],
      title: "測試",
      tool: "knowledge_write",
    };

    expect(knowledgeRequestHash(reordered)).toBe(knowledgeRequestHash(request));
    expect(knowledgeRequestHash(request)).toBe(
      "499cad7084b8b87e50a19a018d7c094c3f9b71352e6b2f2c7cf329a2d2010992",
    );
  });
});
