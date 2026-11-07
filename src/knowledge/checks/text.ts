import type { KnowledgeFile, TextField } from "./types.ts";

export function decodeContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

/** 行數以實際換行計算；檔尾的單一換行不算多一行。 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return text.endsWith("\n") || text.endsWith("\r") ? lines.length - 1 : lines.length;
}

export function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** 把 name、title、description 與每個檔案的路徑和內容轉成掃描欄位。 */
export function textFieldsFrom(input: {
  name?: string;
  title?: string;
  description?: string;
  files?: readonly KnowledgeFile[];
}): TextField[] {
  const fields: TextField[] = [];
  if (input.name !== undefined) {
    fields.push({ field: "name", content: input.name });
  }
  if (input.title !== undefined) {
    fields.push({ field: "title", content: input.title });
  }
  if (input.description !== undefined) {
    fields.push({ field: "description", content: input.description });
  }
  (input.files ?? []).forEach((file, index) => {
    const path = normalizeFilePath(file.path);
    fields.push({ field: `files[${index}].path`, path, content: path });
    fields.push({
      field: `files[${index}].content`,
      path,
      content: decodeContent(file.content),
    });
  });
  return fields;
}
