import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, canonicalJsonPretty, sha256Bytes } from "./canonical.ts";
import { ExportV3Error } from "./errors.ts";
import type { PackageBuild } from "./types.ts";

function writeJsonLines(path: string, records: readonly unknown[]): void {
  const body = records.map((record) => canonicalJson(record)).join("\n");
  writeFileSync(path, records.length === 0 ? "" : `${body}\n`, "utf8");
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writePackageContents(root: string, build: PackageBuild): void {
  ensureDirectory(join(root, "knowledge", "files"));
  ensureDirectory(join(root, "raw", "project"));
  ensureDirectory(join(root, "raw", "global"));

  writeJsonLines(join(root, "work.jsonl"), build.work);
  writeJsonLines(join(root, "events.jsonl"), build.events);
  writeJsonLines(join(root, "evidence.jsonl"), build.evidence);
  writeJsonLines(join(root, "signals.jsonl"), build.signals);
  writeJsonLines(
    join(root, "knowledge", "index.jsonl"),
    build.knowledge.map((entry) => entry.record),
  );
  writeJsonLines(join(root, "mapping.jsonl"), build.mapping);

  for (const entry of build.knowledge) {
    const directory = join(root, "knowledge", "files", entry.record.knowledgeId);
    ensureDirectory(directory);
    writeFileSync(join(directory, "v1.md"), entry.body, "utf8");
  }

  for (const file of build.raw) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.absolutePath);
    } catch (error) {
      throw new ExportV3Error(
        "SOURCE_UNREADABLE",
        `讀取來源檔失敗：${file.absolutePath}`,
        [String(error)],
      );
    }
    if (sha256Bytes(bytes) !== file.sha256) {
      throw new ExportV3Error(
        "SOURCE_CHANGED_DURING_EXPORT",
        `來源檔在匯出期間被修改：${file.absolutePath}`,
      );
    }
    const target = join(root, "raw", file.layer, file.safePath);
    ensureDirectory(dirname(target));
    writeFileSync(target, bytes);
  }

  writeFileSync(
    join(root, "manifest.json"),
    canonicalJsonPretty(build.manifest),
    "utf8",
  );
}

function hasEntries(path: string): boolean {
  return readdirSync(path).length > 0;
}

/** 寫完後再核對一次來源雜湊，確保匯出期間沒有人改過來源。 */
function verifySourcesUnchanged(build: PackageBuild): void {
  for (const file of build.raw) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.absolutePath);
    } catch (error) {
      throw new ExportV3Error(
        "SOURCE_UNREADABLE",
        `讀取來源檔失敗：${file.absolutePath}`,
        [String(error)],
      );
    }
    if (sha256Bytes(bytes) !== file.sha256) {
      throw new ExportV3Error(
        "SOURCE_CHANGED_DURING_EXPORT",
        `來源檔在匯出期間被修改：${file.absolutePath}`,
      );
    }
  }
}

export interface WritePackageOptions {
  force: boolean;
}

/**
 * 先寫到輸出資料夾旁邊的暫存資料夾，完成後才換上去。
 * 任何一步失敗都不會留下半套輸出，也不會邊寫邊覆蓋既有內容。
 */
export function writePackage(
  outputPath: string,
  build: PackageBuild,
  options: WritePackageOptions,
): string {
  const out = resolve(outputPath);
  if (existsSync(out)) {
    let stats;
    try {
      stats = statSync(out);
    } catch (error) {
      throw new ExportV3Error("OUTPUT_UNREADABLE", `無法讀取輸出位置：${out}`, [String(error)]);
    }
    if (!stats.isDirectory()) {
      throw new ExportV3Error("OUTPUT_NOT_A_DIRECTORY", `輸出位置不是資料夾：${out}`);
    }
    if (!options.force && hasEntries(out)) {
      throw new ExportV3Error(
        "OUTPUT_NOT_EMPTY",
        `輸出資料夾不是空的：${out}。要用新匯出取代時請加上 --force。`,
      );
    }
  }

  ensureDirectory(dirname(out));
  const temporary = mkdtempSync(join(dirname(out), `.${basename(out)}.tmp-`));
  let backup: string | undefined;
  try {
    writePackageContents(temporary, build);
    verifySourcesUnchanged(build);
    const existed = existsSync(out);
    if (existed) {
      backup = `${out}.old-${process.pid}-${Date.now()}`;
      renameSync(out, backup);
    }
    renameSync(temporary, out);
    if (backup !== undefined) rmSync(backup, { recursive: true, force: true });
    return out;
  } catch (error) {
    if (backup !== undefined && !existsSync(out)) {
      try {
        renameSync(backup, out);
      } catch {
        // 還原失敗時保留 backup 路徑，讓使用者可以手動取回。
      }
    }
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
