import type { Command } from "../command.ts";
import { failureFromError } from "../../shared/result.ts";
import { linkSkills } from "../../skill-link/link.ts";
import type { SkillHost, SkillLinkResult, SkillLinkSummary } from "../../skill-link/types.ts";

const USAGE = "用法：smilework link [--dry-run] [--project <path>] [--host all|claude|pi]";

type HostOption = SkillHost | "all";

interface ParsedArgs {
  readonly dryRun: boolean;
  readonly projectPath: string | undefined;
  readonly host: HostOption;
  readonly help: boolean;
  readonly error: string | undefined;
}

function parseHost(value: string): HostOption | undefined {
  if (value === "all" || value === "claude" || value === "pi") return value;
  return undefined;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let dryRun = false;
  let projectPath: string | undefined;
  let host: HostOption = "all";
  let help = false;
  let error: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? args[index + 1] : arg.slice("--host=".length);
      if (value === undefined || value.startsWith("--")) {
        error = "--host 缺少值。";
        continue;
      }
      if (arg === "--host") index += 1;
      const parsed = parseHost(value);
      if (parsed === undefined) {
        error = "--host 只能是 all、claude 或 pi。";
        continue;
      }
      host = parsed;
      continue;
    }
    if (arg === "--project" || arg.startsWith("--project=")) {
      if (projectPath !== undefined) {
        error = "重複指定 --project。";
        continue;
      }
      if (arg === "--project") {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) {
          error = "--project 缺少路徑值。";
          continue;
        }
        projectPath = next;
        index += 1;
        continue;
      }
      const value = arg.slice("--project=".length);
      if (value === "") {
        error = "--project 缺少路徑值。";
        continue;
      }
      projectPath = value;
      continue;
    }
    error = `不支援的參數：${arg}`;
  }

  return { dryRun, projectPath, host, help, error };
}

function layerLabel(result: SkillLinkResult): string {
  return result.layer === "global" ? "全域" : "專案";
}

function resultLine(result: SkillLinkResult, dryRun: boolean): string {
  const prefix = `[${layerLabel(result)}/${result.host}]`;
  if (result.outcome === "conflict") {
    return `衝突 ${prefix} ${result.linkPath}：${result.reason ?? "未覆蓋"}（來源：${result.sourcePath}）`;
  }
  if (result.outcome === "skipped") {
    return `略過 ${prefix} ${result.linkPath} -> ${result.sourcePath}（${result.reason ?? "已連結"}）`;
  }
  return `${dryRun ? "將建立" : "建立"} ${prefix} ${result.linkPath} -> ${result.sourcePath}`;
}

function printSummary(summary: SkillLinkSummary): void {
  for (const target of summary.hosts) {
    console.log(`[${target.host}] 全域技能連結：${target.globalLinkRoot}`);
    if (target.projectLinkRoot) {
      console.log(`[${target.host}] 專案技能連結：${target.projectLinkRoot}`);
    }
  }
  if (summary.dryRun) console.log("（dry-run：只列出計畫，不寫入）");

  for (const source of summary.sources) {
    const label = source.layer === "global" ? "全域技能" : "專案技能";
    const detail = source.exists ? `${source.skillCount} 個` : "不存在";
    console.log(`${label}：${source.root}（${detail}）`);
  }

  if (summary.results.length === 0) {
    console.log("沒有找到可連結的技能。");
  }
  for (const result of summary.results) {
    console.log(resultLine(result, summary.dryRun));
  }

  for (const overlap of summary.overlaps) {
    console.log(
      `同名技能 ${overlap.name}（${overlap.host}）：全域 ${overlap.globalLinkPath} -> ${overlap.globalSourcePath}；專案 ${overlap.projectLinkPath} -> ${overlap.projectSourcePath}（兩層各自使用獨立目標，互不覆蓋）`,
    );
  }

  const created = summary.results.filter((result) => result.outcome === "created").length;
  const skipped = summary.results.filter((result) => result.outcome === "skipped").length;
  const conflicts = summary.results.filter((result) => result.outcome === "conflict").length;
  console.log(`摘要：${summary.dryRun ? "將建立" : "建立"} ${created}、略過 ${skipped}、衝突 ${conflicts}`);
  console.log("孤兒連結不會自動清理：來源移除後或不再由這個指令管理的既有 symlink 會留著，需要時請手動處理。");
}

export const command: Command = {
  description: "連結技能到 Claude Code 的掛載位置",
  async run(args: readonly string[]): Promise<number> {
    const parsed = parseArgs(args);
    if (parsed.help) {
      console.log(USAGE);
      console.log("  --dry-run          只列出計畫，不建立 symlink");
      console.log("  --project <path>   一併把專案層 .agents/skills 連到 <repo>/.claude/skills 與 <repo>/.pi/skills");
      console.log("  --host <名稱>      all（預設）、claude 或 pi；預設會處理已安裝的宿主");
      return 0;
    }
    if (parsed.error) {
      console.error(`錯誤：${parsed.error}`);
      console.error(USAGE);
      return 1;
    }

    try {
      const summary = await linkSkills({
        ...(parsed.projectPath ? { projectPath: parsed.projectPath } : {}),
        ...(parsed.dryRun ? { dryRun: true } : {}),
        ...(parsed.host === "all" ? {} : { hosts: [parsed.host] }),
      });
      printSummary(summary);
      return summary.results.some((result) => result.outcome === "conflict") ? 1 : 0;
    } catch (error) {
      const failure = failureFromError(error);
      console.error(`錯誤：${failure.message}`);
      console.error(`下一步：${failure.nextAction}`);
      return 1;
    }
  },
};
