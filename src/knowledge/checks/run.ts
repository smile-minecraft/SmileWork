import { checkSkillLayerConflict } from "./conflicts.ts";
import { checkDangerousPatterns } from "./dangerous.ts";
import { checkSkillFrontmatter } from "./frontmatter.ts";
import { CHECK_CODES, issueResult, mergeResults } from "./result.ts";
import { checkSecrets } from "./secrets.ts";
import { checkSizeBudget } from "./size.ts";
import {
  checkSkillDescription,
  checkSkillMarkdown,
  checkSkillName,
} from "./skill.ts";
import { textFieldsFrom } from "./text.ts";
import type {
  CheckResult,
  KnowledgeCheckContext,
  KnowledgeCheckInput,
  SizedContent,
} from "./types.ts";

function sizeParts(input: KnowledgeCheckInput): SizedContent[] {
  const parts: SizedContent[] = (input.files ?? []).map((file, index) => ({
    content: file.content,
    field: `files[${index}].content`,
  }));
  if (input.description !== undefined) {
    parts.push({ content: input.description, field: "description" });
  }
  return parts;
}

/**
 * 知識寫入前的完整靜態檢查。只有技能才套用名稱、description、
 * frontmatter 與 `SKILL.md` 規則；所有內容都會掃描大小、機密與危險模式，
 * 提供 db 時再檢查跨層同名。
 */
export function checkKnowledgeWrite(
  input: KnowledgeCheckInput,
  context: KnowledgeCheckContext = {},
): CheckResult {
  const options = context.options ?? {};
  const files = input.files ?? [];
  const textFields = textFieldsFrom(input);
  const results: CheckResult[] = [];

  if (input.kind === "skill") {
    const directoryName = input.directoryName;
    if (directoryName === undefined || directoryName.length === 0) {
      results.push(
        issueResult([
          {
            code: CHECK_CODES.skillDirectoryRequired,
            field: "directoryName",
            message: "技能檢查需要提供資料夾名稱，才能確認 name 與目錄一致。",
          },
        ]),
      );
    }

    results.push(
      checkSkillName(
        {
          name: input.name,
          ...(directoryName === undefined ? {} : { directoryName }),
        },
        options,
      ),
      checkSkillDescription(input.description, options),
      checkSkillMarkdown(files, options),
      checkSkillFrontmatter(files, {
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
      }),
    );
  }

  results.push(
    checkSizeBudget(sizeParts(input), options.sizeBudget),
    checkSecrets(textFields),
    checkDangerousPatterns(textFields, options.dangerousSeverity ?? "warning"),
  );

  if (input.kind === "skill" && context.db !== undefined) {
    results.push(
      checkSkillLayerConflict({
        db: context.db,
        name: input.name,
        layer: input.layer,
        projectId: input.projectId ?? null,
      }),
    );
  }

  return mergeResults(...results);
}
