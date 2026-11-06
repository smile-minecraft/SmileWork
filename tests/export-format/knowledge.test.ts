import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { examplePackageInput } from "./helpers/fixture";
import { readJsonl, validatePackage } from "./helpers/package";
import { captureValidationError, createTempDir } from "./helpers/temp";
import { writeJsonLinesFile, writePackage } from "./helpers/writer";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function freshPackage(): string {
  const root = join(createTempDir(), "package");
  writePackage(root, examplePackageInput(), CREATED_AT);
  return root;
}

describe("knowledge 目錄", () => {
  test("缺少版本檔案會被拒絕", () => {
    const root = freshPackage();
    rmSync(join(root, "knowledge/files/k-export-format/v2.md"));

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("KNOWLEDGE_FILE_MISSING");
  });

  test("版本檔案內容與 sha256 不符會被拒絕", () => {
    const root = freshPackage();
    writeFileSync(
      join(root, "knowledge/files/k-export-format/v1.md"),
      "被竄改的內容\n",
      "utf8",
    );

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("KNOWLEDGE_HASH_MISMATCH");
  });

  test("currentVersion 不在 versions 內會被拒絕", () => {
    const root = freshPackage();
    const index = readJsonl(join(root, "knowledge/index.jsonl"));
    const first = index[0] as Record<string, unknown>;
    index[0] = { ...first, currentVersion: 99 };
    writeJsonLinesFile(join(root, "knowledge/index.jsonl"), index);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("KNOWLEDGE_CURRENT_VERSION_MISSING");
  });

  test("knowledge 目錄的未知檔案會被拒絕", () => {
    const root = freshPackage();
    writeFileSync(join(root, "knowledge/extra.md"), "extra", "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("KNOWLEDGE_LAYOUT_INVALID");
  });

  test("未登錄的版本檔案會被拒絕", () => {
    const root = freshPackage();
    writeFileSync(join(root, "knowledge/files/k-export-format/v3.md"), "extra\n", "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("KNOWLEDGE_LAYOUT_INVALID");
  });
});
