import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../src/shared/atomic-write.ts";
import { parseJsonc, stripJsoncComments } from "../../src/shared/jsonc.ts";
import { withTempDir } from "../helpers/temp.ts";

describe("JSONC", () => {
  test("剝除整行、行尾與區塊註解", () => {
    const text = `{
      // 整行註解
      "a": 1, // 行尾
      /* 區塊
         註解 */
      "b": 2
    }`;

    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  test("字串裡的 // 與 /* 不會被當成註解", () => {
    const text = '{"url":"https://example.com/a/*b*/","note":"// not comment"}';

    expect(parseJsonc(text)).toEqual({
      url: "https://example.com/a/*b*/",
      note: "// not comment",
    });
    expect(stripJsoncComments(text)).toBe(text);
  });

  test("尾逗號被拒絕", () => {
    expect(() => parseJsonc('{"a":1,}')).toThrow(SyntaxError);
    expect(() => parseJsonc('{"a":[1,2,],}')).toThrow(SyntaxError);
  });

  test("格式錯誤被拒絕", () => {
    expect(() => parseJsonc("{broken")).toThrow(SyntaxError);
  });
});

describe("atomic-write", () => {
  test("寫入檔案且不留下暫存檔", async () => {
    await withTempDir("atomic", async (root) => {
      const target = join(root, "nested", "file.txt");
      await Bun.write(join(root, "nested", ".keep"), "");

      atomicWriteFile(target, "content");

      expect(await readFile(target, "utf8")).toBe("content");
      const entries = await Array.fromAsync(new Bun.Glob("*.tmp").scan({ cwd: join(root, "nested") }));
      expect(entries).toEqual([]);
    });
  });

  test("覆寫既有檔案", async () => {
    await withTempDir("atomic-overwrite", async (root) => {
      const target = join(root, "file.txt");
      await Bun.write(target, "old");

      atomicWriteFile(target, "new");

      expect(await readFile(target, "utf8")).toBe("new");
    });
  });
});
