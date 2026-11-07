/**
 * 共用錯誤型別。工具回傳與 CLI 都靠 code 判斷錯誤種類，訊息只給人看。
 */

export const ERROR_CODES = {
  notImplemented: "NOT_IMPLEMENTED",
  validation: "VALIDATION_ERROR",
  invalidInput: "INVALID_INPUT",
  internal: "INTERNAL_ERROR",
  projectRequired: "PROJECT_REQUIRED",
  projectNotFound: "PROJECT_NOT_FOUND",
  notGitRepository: "NOT_GIT_REPOSITORY",
  projectIdConflict: "PROJECT_ID_CONFLICT",
  missingProjectReference: "MISSING_PROJECT_REFERENCE",
  pathNotAllowed: "PATH_NOT_ALLOWED",
  secretDetected: "SECRET_DETECTED",
  versionConflict: "VERSION_CONFLICT",
  notFound: "NOT_FOUND",
  database: "DATABASE_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 帶固定錯誤碼與下一步的例外，讓工具外框不必猜測怎麼回報。 */
export class SmileworkError extends Error {
  readonly code: ErrorCode | string;
  readonly nextAction: string;
  readonly data: Record<string, unknown>;

  constructor(
    code: ErrorCode | string,
    message: string,
    nextAction: string,
    data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SmileworkError";
    this.code = code;
    this.nextAction = nextAction;
    this.data = data;
  }
}

export function isSmileworkError(error: unknown): error is SmileworkError {
  return error instanceof SmileworkError;
}
