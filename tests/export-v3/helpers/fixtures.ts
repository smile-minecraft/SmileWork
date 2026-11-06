import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fixturePath(name: string): string {
  return join(import.meta.dir, "..", "fixtures", name);
}

export function makeTempDir(prefix = "smilework-export-v3-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FixtureProject {
  root: string;
  ultrawork: string;
}

/** 把 v2-data 複製成暫存專案的 `.ultrawork/`。 */
export function copyFixtureProject(): FixtureProject {
  const root = makeTempDir();
  const ultrawork = join(root, ".ultrawork");
  cpSync(fixturePath("v2-data"), ultrawork, { recursive: true });
  return { root, ultrawork };
}

/** 把 v2-global 複製成暫存的全域層根目錄。 */
export function copyGlobalFixture(): string {
  const root = makeTempDir();
  const global = join(root, "global");
  cpSync(fixturePath("v2-global"), global, { recursive: true });
  return global;
}

export function listRelativeFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, relative));
      continue;
    }
    if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const relative of listRelativeFiles(root)) {
    result[relative] = sha256Bytes(readFileSync(join(root, relative)));
  }
  return result;
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

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}
