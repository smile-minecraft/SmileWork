import { ExportV3Error } from "./errors.ts";
import { exportV3 } from "./index.ts";

const USAGE = [
  "用法：smilework export-v3 --project <專案路徑> [--global <全域層目錄>] --out <輸出資料夾> [--force]",
  "",
  "把舊版 ultrawork v3 的 .ultrawork/ 資料匯出成 smilework-export v1。",
  "來源只讀；輸出資料夾不是空的時候要加 --force。",
  "（不帶參數時只顯示說明；互動模式尚未實作。）",
  "",
].join("\n");

interface CliOptions {
  project: string;
  global?: string;
  out: string;
  force: boolean;
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new ExportV3Error("INVALID_ARGUMENT", `${flag} 缺少值`);
  }
  return value;
}

function parseArgs(args: readonly string[]): CliOptions {
  let project: string | undefined;
  let globalPath: string | undefined;
  let out: string | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);

    switch (flag) {
      case "--project": {
        project = inlineValue ?? readValue(args, index, flag);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case "--global": {
        globalPath = inlineValue ?? readValue(args, index, flag);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case "--out": {
        out = inlineValue ?? readValue(args, index, flag);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case "--force": {
        if (inlineValue !== undefined) {
          throw new ExportV3Error("INVALID_ARGUMENT", "--force 不接受值");
        }
        force = true;
        break;
      }
      default:
        throw new ExportV3Error("INVALID_ARGUMENT", `未知的參數：${argument}`);
    }
  }

  if (project === undefined || project === "") {
    throw new ExportV3Error("INVALID_ARGUMENT", "缺少 --project");
  }
  if (out === undefined || out === "") {
    throw new ExportV3Error("INVALID_ARGUMENT", "缺少 --out");
  }
  return {
    project,
    ...(globalPath === undefined || globalPath === "" ? {} : { global: globalPath }),
    out,
    force,
  };
}

function printWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  process.stderr.write(`警告 ${warnings.length} 筆：\n`);
  for (const warning of warnings) process.stderr.write(`  ${warning}\n`);
}

/** `export-v3` 子命令的入口。回傳程序結束碼。 */
export function runExportV3(args: readonly string[]): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const options = parseArgs(args);
    const result = exportV3(options);
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
    if (error instanceof ExportV3Error) {
      process.stderr.write(`export-v3：${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  ${detail}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`export-v3：${message}\n`);
    return 1;
  }
}
