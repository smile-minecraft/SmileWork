import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 測試用的固定產生時間。 */
export const FIXED_CREATED_AT = "2026-11-07T00:00:00.000Z";

/** 複製一份去識別化 fixture 到暫存目錄。 */
export function copyFixture(name: "v2-data" | "v2-global"): string {
  const directory = mkdtempSync(join(tmpdir(), `smilework-export-v3-${name}-`));
  cpSync(join(import.meta.dir, "..", "fixtures", name), directory, { recursive: true });
  return directory;
}

/** 建立空的暫存目錄。 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `smilework-export-v3-${prefix}-`));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** 遞迴列出一般檔案，回傳相對於根目錄、以 `/` 分隔的路徑。 */
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

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 掃描整個目錄的檔案雜湊，用來證明來源沒有被寫入。 */
export function scanHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const relative of listFiles(root)) {
    hashes.set(relative, sha256File(join(root, relative)));
  }
  return hashes;
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
