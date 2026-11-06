import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exampleFixtureDir, examplePackageInput } from "./helpers/fixture";
import {
  readJsonl,
  validatePackage,
  type PackageValidationError,
} from "./helpers/package";
import { captureValidationError, createTempDir } from "./helpers/temp";
import { writeJsonLinesFile, writePackage } from "./helpers/writer";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function freshPackage(createdAt = CREATED_AT): string {
  const root = join(createTempDir(), "package");
  writePackage(root, examplePackageInput(), createdAt);
  return root;
}

function expectTimestampError(run: () => unknown): PackageValidationError {
  const error = captureValidationError(run);
  expect(error.code).toBe("TIMESTAMP_IN_CONTENT");
  return error;
}

describe("內容檔案不含產生時間", () => {
  test("範例包的內容檔案只有 manifest 有 createdAt", () => {
    const root = exampleFixtureDir();
    const pkg = validatePackage(root);

    expect(pkg.manifest.createdAt).toBe(CREATED_AT);
    for (const file of [
      "work.jsonl",
      "events.jsonl",
      "evidence.jsonl",
      "signals.jsonl",
      "knowledge/index.jsonl",
      "mapping.jsonl",
    ]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text.includes("createdAt")).toBe(false);
      expect(text.includes(CREATED_AT)).toBe(false);
    }
  });

  test("raw/ 保留來源的時間戳，仍然可以通過驗證", () => {
    const root = exampleFixtureDir();
    const rawTasks = readFileSync(join(root, "raw/project/tasks.json"), "utf8");

    expect(rawTasks).toContain("updatedAt");
    expect(() => validatePackage(root)).not.toThrow();
  });

  test("work.jsonl 被加入 createdAt 時會被檔案層級檢查抓到", () => {
    const root = freshPackage();
    const work = readJsonl(join(root, "work.jsonl"));
    const first = work[0] as Record<string, unknown>;
    work[0] = { ...first, createdAt: CREATED_AT };
    writeJsonLinesFile(join(root, "work.jsonl"), work);

    const error = expectTimestampError(() => validatePackage(root));

    expect(error.details.join("\n")).toContain("createdAt");
  });

  test("事件的 summary 洩漏 manifest 產生時間會被抓到", () => {
    const root = freshPackage();
    const events = readJsonl(join(root, "events.jsonl"));
    const first = events[0] as Record<string, unknown>;
    events[0] = { ...first, summary: `匯出於 ${CREATED_AT}` };
    writeJsonLinesFile(join(root, "events.jsonl"), events);

    expectTimestampError(() => validatePackage(root));
  });

  test("知識版本內容洩漏 manifest 產生時間會被抓到", () => {
    const root = freshPackage();
    const versionPath = join(root, "knowledge/files/k-export-format/v1.md");
    const original = readFileSync(versionPath, "utf8");
    writeFileSync(versionPath, `${original}\n匯出於 ${CREATED_AT}\n`, "utf8");

    expectTimestampError(() => validatePackage(root));
  });
});
