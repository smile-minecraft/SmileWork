import type { ProjectContext } from "../domain/project.ts";
import { isProjectResolutionError } from "../mcp/context.ts";
import type { ToolContext } from "../mcp/types.ts";
import { SmileworkError } from "../shared/errors.ts";
import { SIGNAL_ERROR_CODES } from "./errors.ts";

/** 專案範圍的訊號一定要有專案可歸屬；解析失敗時轉成訊號工具自己的錯誤碼。 */
export function requireSignalProject(
  context: ToolContext,
  explicitPath?: string,
): ProjectContext {
  try {
    return context.resolveProject(explicitPath);
  } catch (error) {
    if (!isProjectResolutionError(error)) throw error;

    const cause = error instanceof SmileworkError ? error : null;
    throw new SmileworkError(
      SIGNAL_ERROR_CODES.projectUnresolved,
      `無法解析訊號所屬專案：${error instanceof Error ? error.message : String(error)}`,
      "設定 SMILEWORK_PROJECT、在 git repo 內執行，或在參數提供 projectPath；全域訊號請設定 scope=global。",
      { causeCode: cause?.code ?? null, path: cause?.data.path ?? null },
    );
  }
}
