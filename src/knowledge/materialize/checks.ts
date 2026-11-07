import type { Database } from "bun:sqlite";
import {
  CHECK_CODES,
  checkKnowledgeWrite,
  checkSecrets,
  type CheckIssue,
  type CheckResult,
  type KnowledgeFile,
} from "../checks/index.ts";
import type { KnowledgeKind, KnowledgeLayer } from "../../domain/knowledge.ts";
import { SmileworkError } from "../../shared/errors.ts";
import { KNOWLEDGE_TOOL_ERROR_CODES } from "./errors.ts";

export interface WriteCheckInput {
  kind: KnowledgeKind;
  layer: KnowledgeLayer;
  projectId: string | null;
  knowledgeId: string;
  title: string;
  description: string;
  source: string;
  tags: readonly string[];
  reason?: string;
  sourceSignalIds: readonly string[];
  content: string;
  files: readonly KnowledgeFile[];
}

interface CheckFileSet {
  files: KnowledgeFile[];
  mapField(field: string): string;
}

function checkFileSet(input: WriteCheckInput): CheckFileSet {
  const primaryPath = input.kind === "skill" ? "SKILL.md" : `${input.knowledgeId}.md`;
  return {
    files: [{ path: primaryPath, content: input.content }, ...input.files],
    mapField(field: string): string {
      if (field === "files[0].content") return "content";
      if (field === "files[0].path") return "knowledgeId";
      const contentMatch = /^files\[(\d+)\]\.content$/.exec(field);
      if (contentMatch) return `files[${Number(contentMatch[1]) - 1}].content`;
      const pathMatch = /^files\[(\d+)\]\.path$/.exec(field);
      if (pathMatch) return `files[${Number(pathMatch[1]) - 1}].path`;
      return field;
    },
  };
}

function mapIssue(issue: CheckIssue, mapField: (field: string) => string): CheckIssue {
  const mapped = { ...issue, field: mapField(issue.field) };
  if (/^files\[\d+\]\.path$/.test(issue.field)) {
    // path 欄位本身就是被掃描的字串，移除避免把疑似機密回顯到錯誤資料。
    delete mapped.path;
  }
  return mapped;
}

/** 執行知識寫入前的靜態檢查；錯誤欄位已對回工具輸入的名稱。 */
export function runKnowledgeWriteChecks(
  input: WriteCheckInput,
  db?: Database,
): CheckResult {
  const fileSet = checkFileSet(input);
  const result = checkKnowledgeWrite(
    {
      kind: input.kind,
      name: input.knowledgeId,
      title: input.title,
      description: input.description,
      layer: input.layer,
      projectId: input.projectId,
      ...(input.kind === "skill" ? { directoryName: input.knowledgeId } : {}),
      files: fileSet.files,
    },
    db === undefined ? {} : { db },
  );
  const sourceScan = checkSecrets([
    { field: "source", content: input.source },
    { field: "tags", content: input.tags.join("\n") },
    ...(input.reason === undefined ? [] : [{ field: "reason", content: input.reason }]),
    { field: "sourceSignalIds", content: input.sourceSignalIds.join("\n") },
  ]);

  return {
    ok: result.ok && sourceScan.ok,
    errors: [
      ...result.errors.map((issue) => mapIssue(issue, fileSet.mapField)),
      ...sourceScan.errors,
    ],
    warnings: [
      ...result.warnings.map((issue) => mapIssue(issue, fileSet.mapField)),
      ...sourceScan.warnings,
    ],
  };
}

export function throwIfChecksFailed(result: CheckResult): void {
  if (result.ok) return;
  const first = result.errors[0];
  const layerConflict = result.errors.some(
    (issue) => issue.code === CHECK_CODES.skillNameConflict,
  );
  throw new SmileworkError(
    layerConflict
      ? KNOWLEDGE_TOOL_ERROR_CODES.layerConflict
      : KNOWLEDGE_TOOL_ERROR_CODES.checkFailed,
    `知識寫入檢查未通過：${first?.message ?? "內容不符合規則。"}`,
    layerConflict
      ? "同一個技能名稱不能同時存在於專案層與全域層；先退役其中一層或換一個名稱。"
      : "修正 errors 指出的欄位後再寫入。",
    {
      field: first?.field ?? null,
      errors: result.errors,
      warnings: result.warnings,
    },
  );
}
