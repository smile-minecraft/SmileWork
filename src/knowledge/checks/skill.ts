import {
  CHECK_CODES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_MARKDOWN_MAX_LINES,
  SKILL_NAME_MAX_LENGTH,
  issueResult,
} from "./result.ts";
import { countLines, decodeContent, normalizeFilePath } from "./text.ts";
import type {
  CheckIssue,
  CheckOptions,
  CheckResult,
  KnowledgeFile,
  SkillNameInput,
} from "./types.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
const SKILL_MARKDOWN_PATH = "SKILL.md";

export function checkSkillName(input: SkillNameInput, options: CheckOptions = {}): CheckResult {
  const maxLength = options.maxNameLength ?? SKILL_NAME_MAX_LENGTH;
  const { name, directoryName } = input;
  const errors: CheckIssue[] = [];

  if (name.length === 0) {
    errors.push({
      code: CHECK_CODES.skillNameRequired,
      field: "name",
      message: "技能 name 不能是空字串。",
    });
    return issueResult(errors);
  }

  if (name.length > maxLength) {
    errors.push({
      code: CHECK_CODES.skillNameTooLong,
      field: "name",
      message: `技能 name 長度 ${name.length} 超過上限 ${maxLength} 字元。`,
    });
  }

  if (!SKILL_NAME_PATTERN.test(name)) {
    errors.push({
      code: CHECK_CODES.skillNameInvalidCharacters,
      field: "name",
      message: "技能 name 只能使用小寫英文字母、數字與連字號。",
    });
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push({
      code: CHECK_CODES.skillNameEdgeHyphen,
      field: "name",
      message: "技能 name 的開頭與結尾不能是連字號。",
    });
  }

  if (name.includes("--")) {
    errors.push({
      code: CHECK_CODES.skillNameConsecutiveHyphens,
      field: "name",
      message: "技能 name 不能包含連續連字號。",
    });
  }

  if (directoryName !== undefined && directoryName !== name) {
    errors.push({
      code: CHECK_CODES.skillNameDirectoryMismatch,
      field: "name",
      message: `技能 name「${name}」與資料夾名稱「${directoryName}」不一致。`,
    });
  }

  return issueResult(errors);
}

export function checkSkillDescription(
  description: string | undefined,
  options: CheckOptions = {},
): CheckResult {
  const maxLength = options.maxDescriptionLength ?? SKILL_DESCRIPTION_MAX_LENGTH;
  const value = description ?? "";

  if (value.trim().length === 0) {
    return issueResult([
      {
        code: CHECK_CODES.descriptionRequired,
        field: "description",
        message: "技能 description 不能是空的。",
      },
    ]);
  }

  const length = [...value].length;
  if (length > maxLength) {
    return issueResult([
      {
        code: CHECK_CODES.descriptionTooLong,
        field: "description",
        message: `技能 description 長度 ${length} 超過上限 ${maxLength} 字元。`,
      },
    ]);
  }

  return issueResult([]);
}

export function checkSkillMarkdown(
  files: readonly KnowledgeFile[],
  options: CheckOptions = {},
): CheckResult {
  const maxLines = options.maxSkillMarkdownLines ?? SKILL_MARKDOWN_MAX_LINES;
  const index = files.findIndex((file) => normalizeFilePath(file.path) === SKILL_MARKDOWN_PATH);

  if (index < 0) {
    return issueResult([
      {
        code: CHECK_CODES.skillMarkdownMissing,
        field: "files",
        message: "技能缺少根目錄的 SKILL.md。",
      },
    ]);
  }

  const file = files[index];
  if (file === undefined) return issueResult([]);

  const lines = countLines(decodeContent(file.content));
  if (lines > maxLines) {
    return issueResult(
      [],
      [
        {
          code: CHECK_CODES.skillMarkdownTooLong,
          field: `files[${index}].content`,
          path: SKILL_MARKDOWN_PATH,
          message: `SKILL.md 有 ${lines} 行，超過建議上限 ${maxLines} 行；把細節拆到 references/ 等附屬檔案。`,
        },
      ],
    );
  }

  return issueResult([]);
}
