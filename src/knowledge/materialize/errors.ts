import { SmileworkError } from "../../shared/errors.ts";

/** 知識寫入、退役與升級工具對外承諾的錯誤碼。 */
export const KNOWLEDGE_TOOL_ERROR_CODES = {
  validation: "VALIDATION_ERROR",
  checkFailed: "KNOWLEDGE_CHECK_FAILED",
  layerConflict: "KNOWLEDGE_LAYER_CONFLICT",
  entryNotFound: "KNOWLEDGE_ENTRY_NOT_FOUND",
  alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
  targetExists: "KNOWLEDGE_TARGET_EXISTS",
  retired: "KNOWLEDGE_RETIRED",
  globalRetired: "KNOWLEDGE_GLOBAL_RETIRED",
  notActive: "KNOWLEDGE_NOT_ACTIVE",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
  invalidTarget: "KNOWLEDGE_INVALID_TARGET",
  archiveFailed: "KNOWLEDGE_ARCHIVE_FAILED",
  artifactNotFound: "KNOWLEDGE_ARTIFACT_NOT_FOUND",
  artifactAmbiguous: "KNOWLEDGE_ARTIFACT_AMBIGUOUS",
  projectUnresolved: "PROJECT_UNRESOLVED",
} as const;

export function invalidKnowledgeInput(
  message: string,
  nextAction: string,
  data: Record<string, unknown> = {},
): SmileworkError {
  return new SmileworkError(KNOWLEDGE_TOOL_ERROR_CODES.validation, message, nextAction, data);
}
