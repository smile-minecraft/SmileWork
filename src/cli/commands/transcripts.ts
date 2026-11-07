import { existsSync, statSync } from "node:fs";
import { smileworkTranscriptsPath } from "../../shared/paths.ts";
import { readTranscriptConfig, transcriptPaths } from "../../transcripts/config.ts";
import {
  countIndexEntries,
  countIndexSessions,
  getIndexMeta,
  openTranscriptIndexReadonly,
  readSchemaVersion,
} from "../../transcripts/index-db.ts";
import { buildTranscriptIndex } from "../../transcripts/indexer.ts";
import type { Command } from "../command.ts";

const USAGE = [
  "用法：smilework transcripts <子命令>",
  "",
  "子命令：",
  "  status             顯示索引檔、筆數、來源與最後建立時間",
  "  index [--rebuild]  建立或增量更新索引；--rebuild 先清空再重建",
  "",
].join("\n");

export const command: Command = {
  description: "管理對話逐字稿",
  run(args: readonly string[]): number {
    const [subcommand] = args;
    if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }

    if (subcommand === "status") return printStatus();
    if (subcommand === "index") return runIndex(args.includes("--rebuild"));

    process.stderr.write(`未知的 transcripts 子命令：${subcommand}\n\n${USAGE}`);
    return 1;
  },
};

function runIndex(rebuild: boolean): number {
  const report = buildTranscriptIndex({ rebuild });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.errors.length > 0 ? 1 : 0;
}

function printStatus(): number {
  const env = process.env;
  const path = smileworkTranscriptsPath(env);
  const config = readTranscriptConfig(env);
  const paths = transcriptPaths(env);

  if (!existsSync(path)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          path,
          exists: false,
          ready: false,
          entries: 0,
          sessions: 0,
          warnings: 0,
          lastIndexedAt: null,
          sources: config.sources,
          sourcePaths: paths,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const db = openTranscriptIndexReadonly(path);
  if (!db) {
    process.stderr.write(`無法讀取對話索引：${path}\n`);
    return 1;
  }

  try {
    const version = readSchemaVersion(db);
    const lastIndexedAt = version === 1 ? getIndexMeta(db, "last_scan_at") : null;
    const ready = version === 1 && lastIndexedAt !== null;
    if (!ready) {
      process.stdout.write(
        `${JSON.stringify(
          {
            path,
            exists: true,
            sizeBytes: statSync(path).size,
            ready: false,
            entries: 0,
            sessions: 0,
            warnings: 0,
            lastIndexedAt,
            sources: config.sources,
            sourcePaths: paths,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const warnings = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM warnings")
      .get();
    const status = {
      path,
      exists: true,
      sizeBytes: statSync(path).size,
      ready,
      entries: countIndexEntries(db),
      sessions: countIndexSessions(db),
      warnings: warnings?.count ?? 0,
      lastIndexedAt,
      sources: config.sources,
      sourcePaths: paths,
    };
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  } finally {
    db.close();
  }
}
