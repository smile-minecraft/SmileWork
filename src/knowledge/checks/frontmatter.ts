import { CHECK_CODES, issueResult } from "./result.ts";
import { decodeContent, normalizeFilePath } from "./text.ts";
import type { CheckIssue, CheckResult, KnowledgeFile } from "./types.ts";

const SKILL_MARKDOWN_PATH = "SKILL.md";
const FRONTMATTER_BLOCK = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FIELD_LINE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const BLOCK_SCALAR = /^[|>][+-]?$/;

export interface ParsedSkillFrontmatter {
  present: boolean;
  name?: string;
  description?: string;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 只解析 SKILL.md frontmatter 的頂層 name/description。技能格式只需要
 * 這兩個鍵，其餘欄位保留給宿主解讀，不在這裡驗證。
 */
export function parseSkillFrontmatter(text: string): ParsedSkillFrontmatter {
  const block = FRONTMATTER_BLOCK.exec(text);
  if (block === null) {
    return { present: false };
  }

  const lines = (block[1] ?? "").split(/\r\n|\r|\n/);
  const values: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const match = FIELD_LINE.exec(lines[index] ?? "");
    if (match === null) continue;

    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();

    if (BLOCK_SCALAR.test(value)) {
      const collected: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const next = lines[cursor] ?? "";
        if (next.trim().length === 0) {
          collected.push("");
          cursor += 1;
          continue;
        }
        if (!/^\s+/.test(next)) break;
        collected.push(next.replace(/^\s+/, ""));
        cursor += 1;
      }
      index = cursor - 1;
      value = value.startsWith(">")
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else {
      value = unquote(value);
    }

    values[key] = value;
  }

  return {
    present: true,
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.description === undefined ? {} : { description: values.description }),
  };
}

export interface SkillFrontmatterExpectation {
  name: string;
  description?: string;
}

/** 驗證 SKILL.md 的 frontmatter 與呼叫端傳入的 name/description 一致。 */
export function checkSkillFrontmatter(
  files: readonly KnowledgeFile[],
  expected: SkillFrontmatterExpectation,
): CheckResult {
  const index = files.findIndex((file) => normalizeFilePath(file.path) === SKILL_MARKDOWN_PATH);
  if (index < 0) return issueResult([]);

  const file = files[index];
  if (file === undefined) return issueResult([]);

  const field = `files[${index}].content`;
  const parsed = parseSkillFrontmatter(decodeContent(file.content));

  if (!parsed.present) {
    return issueResult([
      {
        code: CHECK_CODES.skillFrontmatterMissing,
        field,
        path: SKILL_MARKDOWN_PATH,
        message: "SKILL.md 缺少 YAML frontmatter。",
      },
    ]);
  }

  const errors: CheckIssue[] = [];

  if (parsed.name === undefined || parsed.name.length === 0) {
    errors.push({
      code: CHECK_CODES.skillFrontmatterNameMissing,
      field,
      path: SKILL_MARKDOWN_PATH,
      message: "SKILL.md frontmatter 缺少 name。",
    });
  } else if (parsed.name !== expected.name) {
    errors.push({
      code: CHECK_CODES.skillFrontmatterNameMismatch,
      field,
      path: SKILL_MARKDOWN_PATH,
      message: "SKILL.md frontmatter 的 name 與輸入的 name 不一致。",
    });
  }

  if (parsed.description === undefined || parsed.description.length === 0) {
    errors.push({
      code: CHECK_CODES.skillFrontmatterDescriptionMissing,
      field,
      path: SKILL_MARKDOWN_PATH,
      message: "SKILL.md frontmatter 缺少 description。",
    });
  } else if (expected.description !== undefined && parsed.description !== expected.description) {
    errors.push({
      code: CHECK_CODES.skillFrontmatterDescriptionMismatch,
      field,
      path: SKILL_MARKDOWN_PATH,
      message: "SKILL.md frontmatter 的 description 與輸入的 description 不一致。",
    });
  }

  return issueResult(errors);
}
