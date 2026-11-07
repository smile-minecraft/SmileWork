import type { Command } from "../command.ts";
import { ImportError, importPackage } from "../../import/index.ts";

const USAGE = [
  "用法：smilework import <資料夾> [--dry-run]",
  "",
  "把 smilework-export v1 套件寫進本機資料庫；來源資料夾只讀。",
  "加上 --dry-run 只列出計數與警告，不寫資料庫。",
  "（不帶參數時只顯示說明；互動模式尚未實作。）",
  "",
].join("\n");

interface CliOptions {
  packageDir: string;
  dryRun: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  let packageDir: string | undefined;
  let dryRun = false;
  for (const argument of args) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new ImportError("INVALID_ARGUMENT", `未知的參數：${argument}`);
    }
    if (packageDir !== undefined) {
      throw new ImportError("INVALID_ARGUMENT", `只能指定一個資料夾：${argument}`);
    }
    packageDir = argument;
  }
  if (packageDir === undefined || packageDir === "") {
    throw new ImportError("INVALID_ARGUMENT", "缺少匯入資料夾");
  }
  return { packageDir, dryRun };
}

function printWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  process.stderr.write(`警告 ${warnings.length} 筆：\n`);
  for (const warning of warnings) process.stderr.write(`  ${warning}\n`);
}

function countLine(counts: {
  work: number;
  events: number;
  evidence: number;
  signals: number;
  knowledge: number;
  knowledgeVersions: number;
  mapping: number;
  raw: number;
}): string {
  return [
    `work ${counts.work}`,
    `events ${counts.events}`,
    `evidence ${counts.evidence}`,
    `signals ${counts.signals}`,
    `knowledge ${counts.knowledge}`,
    `knowledgeVersions ${counts.knowledgeVersions}`,
    `mapping ${counts.mapping}`,
    `raw ${counts.raw}`,
  ].join("、");
}

export const command: Command = {
  description: "匯入 smilework-export v1 資料夾到本機資料庫",
  run(args: readonly string[]): number {
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return 0;
    }
    try {
      const options = parseArgs(args);
      const result = importPackage(options);
      if (result.dryRun) {
        process.stdout.write(`匯入乾跑：${result.packageDir}\n`);
        process.stdout.write(`${countLine(result.counts)}\n`);
        process.stdout.write("不寫資料庫\n");
      } else {
        process.stdout.write(`匯入完成：${result.projectId}\n`);
        process.stdout.write(`資料庫：${result.dbPath ?? ""}\n`);
        process.stdout.write(`${countLine(result.counts)}\n`);
        process.stdout.write(
          `新增 work ${result.inserted.work}、events ${result.inserted.events}、evidence ${result.inserted.evidence}、signals ${result.inserted.signals}、knowledge ${result.inserted.knowledge}、knowledgeVersions ${result.inserted.knowledgeVersions}、mapping ${result.inserted.mapping}、raw ${result.inserted.raw}\n`,
        );
      }
      printWarnings(result.warnings);
      return 0;
    } catch (error) {
      if (error instanceof ImportError) {
        process.stderr.write(`import：${error.message}\n`);
        for (const detail of error.details) process.stderr.write(`  ${detail}\n`);
        return 1;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`import：${message}\n`);
      return 1;
    }
  },
};
