import { openDatabase } from "../../db/index.ts";
import { resolveActor, actorHint } from "../../project/actor.ts";
import { preferRegisteredAncestor } from "../../project/registry.ts";
import { tryResolveProject, resolveProject } from "../../project/resolve.ts";
import type { Command } from "../command.ts";
import { newId } from "../../shared/hash.ts";
import { failureFromError } from "../../shared/result.ts";
import { nowIso } from "../../shared/time.ts";

const USAGE = [
  "用法：smilework usage record --action <動作> [參數]",
  "",
  "參數：",
  "  --action <名稱>       必填，例如 skill_read、skill_use",
  "  --knowledge <ID>      知識或技能 ID",
  "  --layer <global|project>",
  "  --version <版本>      正整數",
  "  --query <文字>        這次使用對應的查詢或情境",
  "  --details <JSON>      額外欄位，必須是 JSON 物件",
  "  --project <路徑>      專案路徑；省略時從 cwd 解析，不在 repo 內則不記專案",
  "  --json                以 JSON 輸出",
  "",
].join("\n");

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const separator = body.indexOf("=");
    if (separator >= 0) {
      values.set(body.slice(0, separator), body.slice(separator + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      index += 1;
    } else {
      flags.add(body);
    }
  }

  return { positionals, values, flags };
}

interface RecordInput {
  action: string;
  knowledgeId: string | null;
  layer: "global" | "project" | null;
  version: number | null;
  query: string | null;
  details: Record<string, unknown> | null;
  projectPath: string | null;
}

const VALUE_OPTIONS = new Set([
  "action",
  "knowledge",
  "layer",
  "version",
  "query",
  "details",
  "project",
]);
const BOOLEAN_OPTIONS = new Set(["json"]);

/** 未知或缺少值的參數直接報錯，避免打錯字卻默默寫入不完整的事件。 */
function assertKnownArgs(parsed: ParsedArgs): void {
  for (const key of parsed.values.keys()) {
    if (!VALUE_OPTIONS.has(key)) throw new Error(`不支援的參數：--${key}`);
  }
  for (const flag of parsed.flags) {
    if (VALUE_OPTIONS.has(flag)) throw new Error(`--${flag} 缺少值。`);
    if (!BOOLEAN_OPTIONS.has(flag)) throw new Error(`不支援的參數：--${flag}`);
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`不支援的參數：${parsed.positionals.slice(1).join("、")}`);
  }
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} 必須是正整數：${value}`);
  }
  return Number(value);
}

function parseDetails(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--details 必須是合法的 JSON 物件。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--details 必須是 JSON 物件，不能是陣列或單純值。");
  }
  return parsed as Record<string, unknown>;
}

function parseRecordInput(args: ParsedArgs): RecordInput {
  const action = args.values.get("action")?.trim();
  if (action === undefined || action === "") {
    throw new Error("缺少 --action；請提供這次使用事件要記錄的動作。");
  }

  const knowledgeId = args.values.get("knowledge")?.trim() || null;
  const layerValue = args.values.get("layer")?.trim();
  let layer: "global" | "project" | null = null;
  if (layerValue !== undefined && layerValue !== "") {
    if (layerValue !== "global" && layerValue !== "project") {
      throw new Error(`--layer 只能是 global 或 project：${layerValue}`);
    }
    layer = layerValue;
  }

  const versionValue = args.values.get("version");
  const version =
    versionValue === undefined ? null : parsePositiveInteger(versionValue, "--version");

  const query = args.values.get("query")?.trim() || null;
  const detailsValue = args.values.get("details");
  const details = detailsValue === undefined ? null : parseDetails(detailsValue);
  const projectPath = args.values.get("project")?.trim() || null;

  return { action, knowledgeId, layer, version, query, details, projectPath };
}

interface UsageRecord {
  usageId: string;
  projectId: string | null;
  layer: string | null;
  knowledgeId: string | null;
  version: number | null;
  action: string;
  actor: string;
  actorModel: string | null;
  query: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

function printFailure(error: unknown): void {
  const failure = failureFromError(error);
  console.error(`錯誤：${failure.message}`);
  console.error(`下一步：${failure.nextAction}`);
}

function recordUsage(input: RecordInput): UsageRecord {
  const env = process.env;
  const actor = resolveActor(env);

  const base =
    input.projectPath !== null
      ? resolveProject({ explicitPath: input.projectPath, env })
      : tryResolveProject({ env });
  const db = openDatabase({ env });
  const usageId = newId("usage");
  const createdAt = nowIso();
  let projectId: string | null = null;
  try {
    projectId = base === null ? null : preferRegisteredAncestor(db, base).projectId;
    db.query(
      `INSERT INTO usage_events (
         usage_id, project_id, layer, knowledge_id, version, action, actor,
         actor_model, query, details, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      usageId,
      projectId,
      input.layer,
      input.knowledgeId,
      input.version,
      input.action,
      actor.name,
      actor.model,
      input.query,
      input.details === null ? null : JSON.stringify(input.details),
      createdAt,
    );
  } finally {
    db.close();
  }

  const hint = actorHint(actor);
  if (hint !== null) console.error(`提示：${hint}`);

  return {
    usageId,
    projectId,
    layer: input.layer,
    knowledgeId: input.knowledgeId,
    version: input.version,
    action: input.action,
    actor: actor.name,
    actorModel: actor.model,
    query: input.query,
    details: input.details,
    createdAt,
  };
}

export const command: Command = {
  description: "記錄工具與知識用量",
  run(args: readonly string[]): number {
    const [first] = args;
    if (
      first === undefined ||
      args.includes("--help") ||
      args.includes("-h")
    ) {
      process.stdout.write(USAGE);
      return 0;
    }

    const parsed = parseArgs(args);
    const [subcommand] = parsed.positionals;
    if (subcommand !== "record") {
      process.stderr.write(`未知的 usage 子命令：${subcommand ?? ""}\n\n${USAGE}`);
      return 1;
    }

    let input: RecordInput;
    try {
      assertKnownArgs(parsed);
      input = parseRecordInput(parsed);
    } catch (error) {
      console.error(`錯誤：${(error as Error).message}`);
      console.error(USAGE);
      return 1;
    }

    try {
      const usage = recordUsage(input);
      if (parsed.flags.has("json")) {
        process.stdout.write(`${JSON.stringify({ usage })}\n`);
      } else {
        console.log(`已記錄使用事件：${usage.usageId}`);
        console.log(`動作：${usage.action}；actor：${usage.actor}；專案：${usage.projectId ?? "未指定"}`);
      }
      return 0;
    } catch (error) {
      printFailure(error);
      return 1;
    }
  },
};
