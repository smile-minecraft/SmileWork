import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { buildPackage } from "./build.ts";
import { ExportV3Error } from "./errors.ts";
import { readSource } from "./source.ts";
import type { Manifest } from "./types.ts";
import { WarningCollector } from "./warnings.ts";
import { writePackage } from "./write.ts";

/**
 * producer 版本。`package.json` 的版本是正式來源，測試會比對兩者；
 * 這裡用常數是為了讓打包後的 CLI 不必依賴執行時的工作目錄。
 */
export const PRODUCER_VERSION = "0.1.0";

export interface ExportV3Options {
  /** 專案根目錄，或直接指向 `.ultrawork/`。 */
  project: string;
  /** 全域來源目錄，或直接指向含 `.ultrawork/` 的設定目錄。 */
  global?: string;
  /** 匯出包資料夾。 */
  out: string;
  /** 目標資料夾已有內容時是否取代。 */
  force?: boolean;
  /** `force` 的別名。 */
  replace?: boolean;
  /** producer 版本；不傳時使用 `PRODUCER_VERSION`。 */
  producerVersion?: string;
  /** 固定 manifest.createdAt；不傳時使用目前時間。 */
  createdAt?: string;
  /** 測試可以注入時間；`createdAt` 優先。 */
  now?: () => Date;
}

export interface ExportV3Result {
  out: string;
  outDir: string;
  manifest: Manifest;
  warnings: string[];
}

function isInside(child: string, parent: string): boolean {
  const childPath = resolve(child);
  const parentPath = resolve(parent);
  const relativePath = relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * 把路徑解析成實際位置，連還不存在的尾段也一起處理。
 * 這樣 `--out` 經過 symlink 指進來源時，比對才會看到真正的來源。
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return resolve(real, ...tail);
}

function normalizeCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new ExportV3Error(
      "INVALID_ARGUMENT",
      `createdAt 必須是 UTC ISO 8601 時間，例如 2026-01-01T00:00:00.000Z：${value}`,
    );
  }
  return value;
}

function normalizeProducerVersion(value: string): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new ExportV3Error("INVALID_ARGUMENT", `producerVersion 不是 semver：${value}`);
  }
  return value;
}

/** 把舊版 `.ultrawork/` 匯出成 `smilework-export` v1。 */
export function exportV3(options: ExportV3Options): ExportV3Result {
  const warnings = new WarningCollector();
  const source = readSource(
    {
      project: options.project,
      ...(options.global === undefined ? {} : { global: options.global }),
    },
    warnings,
  );

  const out = resolve(options.out);
  const canonicalOut = canonicalPath(out);
  const canonicalProject = canonicalPath(source.projectRoot);
  const canonicalGlobal = source.globalRoot === undefined ? undefined : canonicalPath(source.globalRoot);
  if (isInside(canonicalOut, canonicalProject)) {
    throw new ExportV3Error(
      "OUTPUT_INSIDE_SOURCE",
      `輸出資料夾不能在來源資料夾內：${out}`,
    );
  }
  if (canonicalGlobal !== undefined && isInside(canonicalOut, canonicalGlobal)) {
    throw new ExportV3Error(
      "OUTPUT_INSIDE_SOURCE",
      `輸出資料夾不能在全域來源資料夾內：${out}`,
    );
  }
  // 反過來也不行：輸出位置若是來源的父層，取代輸出時會把來源一起刪掉。
  if (isInside(canonicalProject, canonicalOut)) {
    throw new ExportV3Error(
      "OUTPUT_CONTAINS_SOURCE",
      `輸出資料夾不能包含來源資料夾：${out}`,
    );
  }
  if (canonicalGlobal !== undefined && isInside(canonicalGlobal, canonicalOut)) {
    throw new ExportV3Error(
      "OUTPUT_CONTAINS_SOURCE",
      `輸出資料夾不能包含全域來源資料夾：${out}`,
    );
  }

  const createdAt =
    options.createdAt === undefined
      ? (options.now?.() ?? new Date()).toISOString()
      : normalizeCreatedAt(options.createdAt);
  const producerVersion = normalizeProducerVersion(options.producerVersion ?? PRODUCER_VERSION);
  const build = buildPackage(source, { createdAt, producerVersion });
  const outDir = writePackage(out, build, {
    force: options.force ?? options.replace ?? false,
  });
  return { out: outDir, outDir, manifest: build.manifest, warnings: build.manifest.warnings };
}
