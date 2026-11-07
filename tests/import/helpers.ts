import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportV3 } from "../../src/export/v3/index.ts";

export const FIXED_CREATED_AT = "2026-11-07T00:00:00.000Z";

export interface V3PackageFixture {
  packageDir: string;
  projectSource: string;
  globalSource?: string;
  cleanup: () => void;
}

/** 用舊 fixture 產生一份真實的 `smilework-export` v1 套件。 */
export function buildV3Package(options: { global?: boolean } = {}): V3PackageFixture {
  const root = mkdtempSync(join(tmpdir(), "smilework-import-fixture-"));
  const projectSource = join(root, "project");
  cpSync(join(import.meta.dir, "..", "export-v3", "fixtures", "v2-data"), projectSource, {
    recursive: true,
  });

  let globalSource: string | undefined;
  if (options.global === true) {
    globalSource = join(root, "global");
    cpSync(join(import.meta.dir, "..", "export-v3", "fixtures", "v2-global"), globalSource, {
      recursive: true,
    });
  }

  const packageDir = join(root, "package");
  exportV3({
    project: projectSource,
    ...(globalSource === undefined ? {} : { global: globalSource }),
    out: packageDir,
    createdAt: FIXED_CREATED_AT,
  });

  return {
    packageDir,
    projectSource,
    ...(globalSource === undefined ? {} : { globalSource }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `smilework-${prefix}-`));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function readJsonLines(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8");
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new Error(`${path} 最後一行缺少換行`);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** 掃描整個資料夾的檔案雜湊，用來證明來源沒有被寫入。 */
export function scanHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const relative of listFiles(root)) {
    hashes[relative] = sha256File(join(root, relative));
  }
  return hashes;
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** 移除 signal details 裡的內部相容鍵，方便比對使用者資料。 */
export function signalUserDetails(record: {
  details?: unknown;
}): Record<string, unknown> | undefined {
  if (record.details === null || typeof record.details !== "object" || Array.isArray(record.details)) {
    return undefined;
  }
  const details = { ...(record.details as Record<string, unknown>) };
  delete details.smileworkExport;
  return Object.keys(details).length > 0 ? details : undefined;
}

/** 讀取 signal details 裡的內部相容資料。 */
export function signalInternalDetails(record: {
  details?: unknown;
}): Record<string, unknown> | undefined {
  if (record.details === null || typeof record.details !== "object" || Array.isArray(record.details)) {
    return undefined;
  }
  const internal = (record.details as Record<string, unknown>).smileworkExport;
  return internal !== null && typeof internal === "object" && !Array.isArray(internal)
    ? (internal as Record<string, unknown>)
    : undefined;
}

/** 比較 signal 時忽略 details 的內部相容鍵。 */
export function stripSignalInternal(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...record };
  const details = signalUserDetails(record);
  if (details === undefined) delete copy.details;
  else copy.details = details;
  return copy;
}

export function stripSignalsInternal(
  records: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return records.map(stripSignalInternal);
}
