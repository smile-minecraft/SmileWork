import type { Command } from "../command.ts";
import { ExportCurrentError, exportCurrent } from "../../export/current/index.ts";

const USAGE = [
  "用法：smilework export --out <資料夾> [--project <專案 ID 或路徑>] [--force]",
  "",
  "從本機資料庫輸出 smilework-export v1。",
  "目標資料夾不是空的時候要加 --force；輸出位置不會被寫回資料庫。",
  "（不帶參數時只顯示說明；互動模式尚未實作。）",
  "",
].join("\n");

interface CliOptions {
  out: string;
  project?: string;
  force: boolean;
  createdAt?: string;
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new ExportCurrentError("INVALID_ARGUMENT", `${flag} 缺少值`);
  }
  return value;
}

function parseArgs(args: readonly string[]): CliOptions {
  let out: string | undefined;
  let project: string | undefined;
  let force = false;
  let createdAt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    switch (flag) {
      case "--out": {
        out = inlineValue ?? readValue(args, index, flag);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case "--project": {
        project = inlineValue ?? readValue(args, index, flag);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case "--created-at": {
        createdAt = inlineValue ?? readValue(args, index, flag);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case "--force": {
        if (inlineValue !== undefined) {
          throw new ExportCurrentError("INVALID_ARGUMENT", "--force 不接受值");
        }
        force = true;
        break;
      }
      default:
        throw new ExportCurrentError("INVALID_ARGUMENT", `未知的參數：${argument}`);
    }
  }

  if (out === undefined || out === "") {
    throw new ExportCurrentError("INVALID_ARGUMENT", "缺少 --out");
  }
  return {
    out,
    ...(project === undefined || project === "" ? {} : { project }),
    force,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function printWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  process.stderr.write(`警告 ${warnings.length} 筆：\n`);
  for (const warning of warnings) process.stderr.write(`  ${warning}\n`);
}

export const command: Command = {
  description: "從本機資料庫匯出 smilework-export v1",
  run(args: readonly string[]): number {
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return 0;
    }
    try {
      const options = parseArgs(args);
      const result = exportCurrent({
        outDir: options.out,
        ...(options.project === undefined ? {} : { projectId: options.project }),
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
        force: options.force,
      });
      const layout = result.manifest.layout;
      process.stdout.write(`匯出完成：${result.outDir}\n`);
      process.stdout.write(
        [
          `work ${layout.work.records}`,
          `events ${layout.events.records}`,
          `evidence ${layout.evidence.records}`,
          `signals ${layout.signals.records}`,
          `knowledge ${layout.knowledge.entries}`,
          `mapping ${layout.mapping.records}`,
          `raw ${layout.raw.files}`,
        ].join("、") + "\n",
      );
      printWarnings(result.warnings);
      return 0;
    } catch (error) {
      if (error instanceof ExportCurrentError) {
        process.stderr.write(`export：${error.message}\n`);
        for (const detail of error.details) process.stderr.write(`  ${detail}\n`);
        return 1;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`export：${message}\n`);
      return 1;
    }
  },
};
