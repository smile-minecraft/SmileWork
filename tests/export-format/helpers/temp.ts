import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exampleFixtureDir } from "./fixture";
import { PackageValidationError } from "./package";

export function createTempDir(prefix = "smilework-export-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function copyExamplePackage(): string {
  const target = join(createTempDir(), "example-export");
  cpSync(exampleFixtureDir(), target, { recursive: true });
  return target;
}

export function captureValidationError(run: () => unknown): PackageValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof PackageValidationError) return error;
    throw error;
  }
  throw new Error("預期驗證失敗，但沒有拋出錯誤");
}
