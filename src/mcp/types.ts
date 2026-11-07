import type { Database } from "bun:sqlite";
import type { ZodObject, ZodRawShape } from "zod";
import type { Actor, ProjectContext } from "../domain/index.ts";
import type { ToolResult } from "../shared/result.ts";

export type ToolDomain = "work" | "verify" | "status" | "signal" | "knowledge" | "transcript";

/** 工具處理常式取得的請求範圍資源；資料庫與專案都是第一次用到才建立。 */
export interface ToolContext {
  readonly actor: Actor;
  /** actor 未設定或 model 未設定時給人看的提示；已設定時是 null。 */
  readonly actorHint: string | null;
  db(): Database;
  resolveProject(explicitPath?: string): ProjectContext;
  tryResolveProject(explicitPath?: string): ProjectContext | null;
  close(): void;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  domain: ToolDomain;
  inputSchema: ZodObject<ZodRawShape>;
  handler: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult> | ToolResult;
}
