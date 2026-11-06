import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { validatePackage } from "./helpers/package";
import { copyExamplePackage, captureValidationError } from "./helpers/temp";
import { canonicalJsonPretty } from "./helpers/writer";

type MutableManifest = {
  format?: unknown;
  formatVersion?: unknown;
  createdAt?: unknown;
  layout?: Record<string, unknown>;
  [key: string]: unknown;
};

function readManifest(root: string): MutableManifest {
  return JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as MutableManifest;
}

function writeManifest(root: string, manifest: MutableManifest): void {
  writeFileSync(join(root, "manifest.json"), canonicalJsonPretty(manifest), "utf8");
}

describe("manifest 必填欄位與版本", () => {
  test("缺少 formatVersion 會被拒絕", () => {
    const root = copyExamplePackage();
    const manifest = readManifest(root);
    delete manifest.formatVersion;
    writeManifest(root, manifest);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MANIFEST_INVALID");
    expect(error.details.join("\n")).toContain("formatVersion");
  });

  test("缺少 createdAt 會被拒絕", () => {
    const root = copyExamplePackage();
    const manifest = readManifest(root);
    delete manifest.createdAt;
    writeManifest(root, manifest);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MANIFEST_INVALID");
    expect(error.details.join("\n")).toContain("createdAt");
  });

  test("formatVersion 不是 1 會被拒絕", () => {
    for (const value of [2, "1", 0]) {
      const root = copyExamplePackage();
      const manifest = readManifest(root);
      manifest.formatVersion = value;
      writeManifest(root, manifest);

      const error = captureValidationError(() => validatePackage(root));

      expect(error.code).toBe("MANIFEST_INVALID");
    }
  });

  test("createdAt 必須是含毫秒的 UTC 時間", () => {
    const root = copyExamplePackage();
    const manifest = readManifest(root);
    manifest.createdAt = "2026-01-01";
    writeManifest(root, manifest);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MANIFEST_INVALID");
  });

  test("layout 出現未知的部分會被拒絕", () => {
    const root = copyExamplePackage();
    const manifest = readManifest(root);
    const layout = manifest.layout ?? {};
    layout.extra = { path: "extra.jsonl" };
    manifest.layout = layout;
    writeManifest(root, manifest);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MANIFEST_INVALID");
  });
});

describe("套件頂層內容", () => {
  test("未知的頂層檔案會被拒絕", () => {
    const root = copyExamplePackage();
    writeFileSync(join(root, "extra.jsonl"), "", "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("UNKNOWN_TOP_LEVEL_ENTRY");
    expect(error.message).toContain("extra.jsonl");
  });

  test("缺少頂層檔案會被拒絕", () => {
    const root = copyExamplePackage();
    rmSync(join(root, "signals.jsonl"));

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MISSING_TOP_LEVEL_ENTRY");
    expect(error.message).toContain("signals.jsonl");
  });

  test("knowledge 必須是資料夾", () => {
    const root = copyExamplePackage();
    rmSync(join(root, "knowledge"), { recursive: true, force: true });
    writeFileSync(join(root, "knowledge"), "not a directory", "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("TOP_LEVEL_TYPE_MISMATCH");
  });
});
