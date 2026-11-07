/** 訊號工具對外的錯誤碼；外框的 code 直接使用這些值。 */
export const SIGNAL_ERROR_CODES = {
  validation: "VALIDATION_ERROR",
  projectUnresolved: "PROJECT_UNRESOLVED",
  signalNotFound: "SIGNAL_NOT_FOUND",
  invalidStatus: "INVALID_STATUS",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
} as const;
