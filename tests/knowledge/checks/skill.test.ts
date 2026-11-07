import { describe, expect, test } from "bun:test";
import {
  CHECK_CODES,
  checkKnowledgeWrite,
  checkSizeBudget,
  checkSkillDescription,
  checkSkillMarkdown,
  checkSkillName,
} from "../../../src/knowledge/checks/index.ts";
import type { KnowledgeFile } from "../../../src/knowledge/checks/types.ts";
import { markdownWithLines } from "./helpers.ts";

const VALID_NAME = "pdf-processing";
const VALID_DESCRIPTION = "Extracts text from PDF files. Use when handling PDFs.";

function skillMarkdown(name = VALID_NAME, description = VALID_DESCRIPTION): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# PDF\n`;
}

function validFiles(): KnowledgeFile[] {
  return [
    { path: "SKILL.md", content: skillMarkdown() },
    { path: "references/notes.md", content: "補充資料。\n" },
  ];
}

function validSkill() {
  return {
    kind: "skill" as const,
    name: VALID_NAME,
    directoryName: VALID_NAME,
    description: VALID_DESCRIPTION,
    layer: "project" as const,
    projectId: "test-project",
    files: validFiles(),
  };
}

describe("技能名稱", () => {
  test("合法名稱與資料夾一致時通過", () => {
    const result = checkSkillName({ name: VALID_NAME, directoryName: VALID_NAME });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("名稱是空字串被拒絕，並指出 name 欄位", () => {
    const result = checkSkillName({ name: "", directoryName: "" });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.skillNameRequired, field: "name" }),
    );
  });

  test("名稱超過 64 字元被拒絕，並指出 name 欄位", () => {
    const result = checkSkillName({ name: "a".repeat(65), directoryName: "a".repeat(65) });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.skillNameTooLong, field: "name" }),
    );
  });

  test("名稱含大寫、空白或非英數字元被拒絕", () => {
    for (const name of ["PDF-Processing", "pdf processing", "pdf_processing", "技能"]) {
      const result = checkSkillName({ name, directoryName: name });

      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: CHECK_CODES.skillNameInvalidCharacters, field: "name" }),
      );
    }
  });

  test("名稱開頭、結尾或連續連字號被拒絕", () => {
    for (const name of ["-pdf", "pdf-", "pdf--processing"]) {
      const result = checkSkillName({ name, directoryName: name });

      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (issue) =>
            issue.code === CHECK_CODES.skillNameEdgeHyphen ||
            issue.code === CHECK_CODES.skillNameConsecutiveHyphens,
        ),
      ).toBe(true);
      expect(result.errors.every((issue) => issue.field === "name")).toBe(true);
    }
  });

  test("名稱與資料夾不一致被拒絕", () => {
    const result = checkSkillName({ name: VALID_NAME, directoryName: "other-folder" });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.skillNameDirectoryMismatch, field: "name" }),
    );
  });
});

describe("技能描述", () => {
  test("description 超過 1024 字元被拒絕", () => {
    const result = checkSkillDescription("字".repeat(1025));

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.descriptionTooLong, field: "description" }),
    );
  });

  test("description 剛好 1024 字元可以通過", () => {
    const result = checkSkillDescription("字".repeat(1024));

    expect(result.ok).toBe(true);
  });

  test("缺少 description 被拒絕", () => {
    const result = checkSkillDescription("");

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.descriptionRequired, field: "description" }),
    );
  });
});

describe("SKILL.md 行數", () => {
  test("超過 500 行只產生警告，不阻擋寫入", () => {
    const result = checkSkillMarkdown([
      { path: "SKILL.md", content: markdownWithLines(501) },
    ]);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillMarkdownTooLong,
        field: "files[0].content",
        path: "SKILL.md",
      }),
    );
  });

  test("剛好 500 行不警告", () => {
    const result = checkSkillMarkdown([
      { path: "SKILL.md", content: markdownWithLines(500) },
    ]);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("缺少 SKILL.md 被拒絕", () => {
    const result = checkSkillMarkdown([{ path: "README.md", content: "只有說明" }]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.skillMarkdownMissing, field: "files" }),
    );
  });
});

describe("SKILL.md frontmatter", () => {
  test("缺少 frontmatter 被拒絕，並指出檔案欄位", () => {
    const result = checkKnowledgeWrite({
      ...validSkill(),
      files: [{ path: "SKILL.md", content: "# 沒有 frontmatter\n" }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillFrontmatterMissing,
        field: "files[0].content",
        path: "SKILL.md",
      }),
    );
  });

  test("frontmatter 的 name 與輸入不一致被拒絕", () => {
    const result = checkKnowledgeWrite({
      ...validSkill(),
      files: [{ path: "SKILL.md", content: skillMarkdown("other-skill") }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillFrontmatterNameMismatch,
        field: "files[0].content",
      }),
    );
  });

  test("frontmatter 的 description 與輸入不一致被拒絕", () => {
    const result = checkKnowledgeWrite({
      ...validSkill(),
      files: [{ path: "SKILL.md", content: skillMarkdown(VALID_NAME, "不同的描述") }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillFrontmatterDescriptionMismatch,
        field: "files[0].content",
      }),
    );
  });

  test("frontmatter 缺少 name 或 description 被拒絕", () => {
    const missingName = checkKnowledgeWrite({
      ...validSkill(),
      files: [{ path: "SKILL.md", content: `---\ndescription: ${VALID_DESCRIPTION}\n---\n` }],
    });
    const missingDescription = checkKnowledgeWrite({
      ...validSkill(),
      files: [{ path: "SKILL.md", content: `---\nname: ${VALID_NAME}\n---\n` }],
    });

    expect(missingName.errors).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillFrontmatterNameMissing,
        field: "files[0].content",
      }),
    );
    expect(missingDescription.errors).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillFrontmatterDescriptionMissing,
        field: "files[0].content",
      }),
    );
  });

  test("frontmatter 的 block scalar description 可以通過", () => {
    const description = "Extracts text from PDF files.\nUse when handling PDFs.";
    const result = checkKnowledgeWrite({
      ...validSkill(),
      description,
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: ${VALID_NAME}\ndescription: |\n  Extracts text from PDF files.\n  Use when handling PDFs.\n---\n`,
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  test("一致時通過", () => {
    const result = checkKnowledgeWrite(validSkill());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("大小預算", () => {
  test("超過預算被拒絕，並指出 files 欄位", () => {
    const files: KnowledgeFile[] = [
      { path: "SKILL.md", content: "a".repeat(64) },
    ];

    const result = checkSizeBudget(files, { maxBytes: 10 });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.sizeBudgetExceeded, field: "files" }),
    );
  });

  test("預算可以設定成只警告", () => {
    const files: KnowledgeFile[] = [{ path: "SKILL.md", content: "0123456789" }];

    const result = checkSizeBudget(files, { maxBytes: 5, severity: "warning" });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.sizeBudgetExceeded, field: "files" }),
    );
  });

  test("Uint8Array 內容以實際位元組計算", () => {
    const files: KnowledgeFile[] = [
      { path: "assets/blob.bin", content: new Uint8Array(32) },
    ];

    const result = checkSizeBudget(files, { maxBytes: 31 });

    expect(result.ok).toBe(false);
  });

  test("description 計入大小預算，300 KiB 描述被拒絕並指出 description", () => {
    const result = checkKnowledgeWrite({
      kind: "memory",
      name: "long-note",
      description: "a".repeat(300 * 1024),
      layer: "project",
      projectId: "test-project",
      files: [{ path: "notes.md", content: "短內容" }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: CHECK_CODES.sizeBudgetExceeded, field: "description" }),
    );
  });
});

describe("技能寫入總檢查", () => {
  test("合法技能通過所有檢查", () => {
    const result = checkKnowledgeWrite(validSkill());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("名稱錯誤會指出 name 欄位，其他檢查照常執行", () => {
    const result = checkKnowledgeWrite({
      ...validSkill(),
      name: "PDF-Processing",
      directoryName: "PDF-Processing",
      files: [{ path: "SKILL.md", content: skillMarkdown("PDF-Processing") }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.field === "name")).toBe(true);
  });

  test("技能沒有 directoryName 被拒絕", () => {
    const result = checkKnowledgeWrite({
      ...validSkill(),
      directoryName: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: CHECK_CODES.skillDirectoryRequired,
        field: "directoryName",
      }),
    );
  });
});
