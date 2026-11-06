import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { examplePackageInput } from "./helpers/fixture";
import { readJsonl, validatePackage } from "./helpers/package";
import { captureValidationError, createTempDir } from "./helpers/temp";
import type { MappingRecord } from "./helpers/types";
import { writeJsonLinesFile, writePackage } from "./helpers/writer";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function freshPackage(): string {
  const root = join(createTempDir(), "package");
  writePackage(root, examplePackageInput(), CREATED_AT);
  return root;
}

function rawMapping(mappings: readonly MappingRecord[]): MappingRecord {
  const record = mappings.find(
    (mapping) => mapping.entity === "raw" && mapping.targetId === "raw/project/tasks.json",
  );
  if (record === undefined) throw new Error("範例包缺少 raw/project/tasks.json 的 mapping");
  return record;
}

describe("mapping 與 raw", () => {
  test("raw 檔案缺少 mapping 會被拒絕", () => {
    const root = freshPackage();
    const mappings = readJsonl(join(root, "mapping.jsonl")) as MappingRecord[];
    writeJsonLinesFile(
      join(root, "mapping.jsonl"),
      mappings.filter((mapping) => mapping.targetId !== "raw/project/tasks.json"),
    );

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("RAW_MAPPING_MISSING");
    expect(error.message).toContain("raw/project/tasks.json");
  });

  test("mapping 的 sha256 與 raw 檔案不符會被拒絕", () => {
    const root = freshPackage();
    const mappings = readJsonl(join(root, "mapping.jsonl")) as MappingRecord[];
    const target = rawMapping(mappings);
    writeJsonLinesFile(
      join(root, "mapping.jsonl"),
      mappings.map((mapping) =>
        mapping === target ? { ...mapping, sha256: "0".repeat(64) } : mapping,
      ),
    );

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("RAW_HASH_MISMATCH");
  });

  test("未登錄的 raw 檔案會被拒絕", () => {
    const root = freshPackage();
    writeFileSync(join(root, "raw/project/extra.txt"), "extra", "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("RAW_MAPPING_MISSING");
  });

  test("mapping 指向不存在的 raw 檔案會被拒絕", () => {
    const root = freshPackage();
    rmSync(join(root, "raw/project/tasks.json"));

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("RAW_FILE_MISSING");
  });

  test("同一個 raw 檔案有兩筆 mapping 會被拒絕", () => {
    const root = freshPackage();
    const mappings = readJsonl(join(root, "mapping.jsonl")) as MappingRecord[];
    const target = rawMapping(mappings);
    const duplicated = [...mappings, { ...target, sourceId: "tasks-duplicate" }].sort(
      (left, right) =>
        [left.entity, left.layer, left.sourceId, left.targetId]
          .join("\u0000")
          .localeCompare([right.entity, right.layer, right.sourceId, right.targetId].join("\u0000")),
    );
    writeJsonLinesFile(join(root, "mapping.jsonl"), duplicated);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("RAW_MAPPING_DUPLICATE");
  });
});
