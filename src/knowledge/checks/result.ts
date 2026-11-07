import type {
  CheckIssue,
  CheckResult,
  CheckSeverity,
} from "./types.ts";

export const CHECK_CODES = {
  skillNameRequired: "SKILL_NAME_REQUIRED",
  skillNameTooLong: "SKILL_NAME_TOO_LONG",
  skillNameInvalidCharacters: "SKILL_NAME_INVALID_CHARACTERS",
  skillNameEdgeHyphen: "SKILL_NAME_EDGE_HYPHEN",
  skillNameConsecutiveHyphens: "SKILL_NAME_CONSECUTIVE_HYPHENS",
  skillNameDirectoryMismatch: "SKILL_NAME_DIRECTORY_MISMATCH",
  descriptionRequired: "DESCRIPTION_REQUIRED",
  descriptionTooLong: "DESCRIPTION_TOO_LONG",
  skillMarkdownMissing: "SKILL_MARKDOWN_MISSING",
  skillMarkdownTooLong: "SKILL_MARKDOWN_TOO_LONG",
  skillDirectoryRequired: "SKILL_DIRECTORY_REQUIRED",
  skillFrontmatterMissing: "SKILL_FRONTMATTER_MISSING",
  skillFrontmatterNameMissing: "SKILL_FRONTMATTER_NAME_MISSING",
  skillFrontmatterNameMismatch: "SKILL_FRONTMATTER_NAME_MISMATCH",
  skillFrontmatterDescriptionMissing: "SKILL_FRONTMATTER_DESCRIPTION_MISSING",
  skillFrontmatterDescriptionMismatch: "SKILL_FRONTMATTER_DESCRIPTION_MISMATCH",
  sizeBudgetExceeded: "SIZE_BUDGET_EXCEEDED",
  secretDetected: "SECRET_DETECTED",
  dangerousCurlPipeShell: "DANGEROUS_CURL_PIPE_SHELL",
  dangerousSshWrite: "DANGEROUS_SSH_WRITE",
  dangerousRmRoot: "DANGEROUS_RM_ROOT",
  skillNameConflict: "SKILL_NAME_CONFLICT",
} as const;

export type CheckCode = (typeof CHECK_CODES)[keyof typeof CHECK_CODES];

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_MARKDOWN_MAX_LINES = 500;
export const DEFAULT_SIZE_BUDGET_BYTES = 256 * 1024;

export function issueResult(errors: CheckIssue[], warnings: CheckIssue[] = []): CheckResult {
  return { ok: errors.length === 0, errors, warnings };
}

export function mergeResults(...results: CheckResult[]): CheckResult {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  for (const result of results) {
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return issueResult(errors, warnings);
}

export function severityBucket(severity: CheckSeverity): "errors" | "warnings" {
  return severity === "error" ? "errors" : "warnings";
}
