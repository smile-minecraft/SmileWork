import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exampleFixtureDir, examplePackageInput } from "./helpers/fixture";
import { PackageValidationError, readJsonl, validatePackage } from "./helpers/package";
import {
  readSchemaDocument,
  validateManifestSchema,
  validateRecordSchema,
} from "./helpers/schemas";
import type { RecordPart } from "./helpers/types";
import { RESOLUTIONS, WORK_STATUSES } from "./helpers/types";
import { canonicalJson, writePackage } from "./helpers/writer";

const RECORD_FILES: Array<[RecordPart, string]> = [
  ["work", "work.jsonl"],
  ["events", "events.jsonl"],
  ["evidence", "evidence.jsonl"],
  ["signals", "signals.jsonl"],
  ["knowledge", "knowledge/index.jsonl"],
  ["mapping", "mapping.jsonl"],
];

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "smilework-export-"));
  tempDirectories.push(directory);
  return directory;
}

function copyExamplePackage(): string {
  const directory = makeTempDirectory();
  cpSync(exampleFixtureDir(), directory, { recursive: true });
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mutateJsonl(path: string, mutate: (records: Record<string, unknown>[]) => void): void {
  const records = readJsonl(path) as Record<string, unknown>[];
  mutate(records);
  writeFileSync(path, `${records.map((record) => canonicalJson(record)).join("\n")}\n`, "utf8");
}

function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
      continue;
    }
    if (entry.isFile()) files.push(relative);
  }
  return files;
}

function expectPackageError(run: () => unknown, code: string): PackageValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageValidationError);
    const packageError = error as PackageValidationError;
    expect(packageError.code).toBe(code);
    return packageError;
  }
  throw new Error(`預期驗證失敗，代碼應為 ${code}`);
}

describe("匯出格式 schema", () => {
  test("schema 文件定義 manifest 與六種記錄", () => {
    const schema = readSchemaDocument();
    expect(schema["$id"]).toBe("urn:smilework:export:v1");

    const definitions = schema["$defs"] as Record<string, unknown>;
    for (const name of [
      "workRecord",
      "eventRecord",
      "evidenceRecord",
      "signalRecord",
      "knowledgeRecord",
      "mappingRecord",
    ]) {
      expect(definitions[name]).toBeDefined();
    }
  });

  test("狀態與 resolution 的列舉固定在 schema 內", () => {
    const schema = readSchemaDocument();
    const definitions = schema["$defs"] as Record<string, { enum?: unknown[] }>;
    expect(definitions.status?.enum).toEqual([...WORK_STATUSES]);
    expect(definitions.resolution?.enum).toEqual([...RESOLUTIONS]);
  });

  test("範例包的 manifest 與每個記錄都通過 schema", () => {
    const root = exampleFixtureDir();
    expect(validateManifestSchema(readJson(join(root, "manifest.json")))).toEqual([]);

    for (const [part, file] of RECORD_FILES) {
      const records = readJsonl(join(root, file));
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(validateRecordSchema(part, record)).toEqual([]);
      }
    }
  });

  test("範例包通過完整驗證", () => {
    const pkg = validatePackage(exampleFixtureDir());
    expect(pkg.manifest.formatVersion).toBe(1);
    expect(pkg.work).toHaveLength(5);
    expect(pkg.events).toHaveLength(7);
    expect(pkg.evidence).toHaveLength(3);
    expect(pkg.signals).toHaveLength(1);
    expect(pkg.knowledge).toHaveLength(4);
    expect(pkg.mapping).toHaveLength(16);
    expect(pkg.rawFiles).toHaveLength(7);
  });
});

describe("匯出包拒絕不合法內容", () => {
  test("manifest 缺少必填欄位被拒絕", () => {
    const root = copyExamplePackage();
    const manifest = readJson(join(root, "manifest.json"));
    delete manifest.producer;
    writeJson(join(root, "manifest.json"), manifest);

    const error = expectPackageError(() => validatePackage(root), "MANIFEST_INVALID");
    expect(error.details.join("\n")).toContain("producer");
  });

  test("formatVersion 不是 1 被拒絕", () => {
    for (const value of [2, 0, "1", 1.5]) {
      const root = copyExamplePackage();
      const manifest = readJson(join(root, "manifest.json"));
      manifest.formatVersion = value;
      writeJson(join(root, "manifest.json"), manifest);

      expectPackageError(() => validatePackage(root), "MANIFEST_INVALID");
    }
  });

  test("manifest 出現未知欄位被拒絕", () => {
    const root = copyExamplePackage();
    const manifest = readJson(join(root, "manifest.json"));
    manifest.exportedBy = "unknown";
    writeJson(join(root, "manifest.json"), manifest);

    expectPackageError(() => validatePackage(root), "MANIFEST_INVALID");
  });

  test("不合法的 work status 被拒絕", () => {
    const root = copyExamplePackage();
    mutateJsonl(join(root, "work.jsonl"), (records) => {
      records[0]!.status = "finished";
    });

    const error = expectPackageError(() => validatePackage(root), "SCHEMA_INVALID");
    expect(error.details.join("\n")).toContain("status");
  });

  test("不合法的 resolution 被拒絕", () => {
    const root = copyExamplePackage();
    mutateJsonl(join(root, "work.jsonl"), (records) => {
      records[0]!.resolution = "done";
    });

    expectPackageError(() => validatePackage(root), "SCHEMA_INVALID");
  });

  test("終態缺少 resolution 被拒絕", () => {
    const root = copyExamplePackage();
    mutateJsonl(join(root, "work.jsonl"), (records) => {
      delete records[0]!.resolution;
    });

    expectPackageError(() => validatePackage(root), "SCHEMA_INVALID");
  });

  test("未知的頂層項目被拒絕", () => {
    const root = copyExamplePackage();
    writeFileSync(join(root, "notes.txt"), "未登錄的內容\n", "utf8");

    expectPackageError(() => validatePackage(root), "UNKNOWN_TOP_LEVEL_ENTRY");
  });

  test("缺少頂層項目被拒絕", () => {
    const root = copyExamplePackage();
    rmSync(join(root, "signals.jsonl"));

    expectPackageError(() => validatePackage(root), "MISSING_TOP_LEVEL_ENTRY");
  });

  test("內容記錄出現時間戳欄位被拒絕", () => {
    const root = copyExamplePackage();
    mutateJsonl(join(root, "work.jsonl"), (records) => {
      records[0]!.createdAt = "2026-10-08T12:00:00.000Z";
    });

    const error = expectPackageError(() => validatePackage(root), "TIMESTAMP_IN_CONTENT");
    expect(error.details.join("\n")).toContain("createdAt");
  });

  test("知識內容出現 manifest 的產生時間被拒絕", () => {
    const root = copyExamplePackage();
    const manifest = readJson(join(root, "manifest.json"));
    const createdAt = manifest.createdAt as string;
    const bodyPath = join(root, "knowledge/files/k-fixture-topic/v1.md");
    const body = `${readFileSync(bodyPath, "utf8")}\n產生時間：${createdAt}\n`;
    writeFileSync(bodyPath, body, "utf8");

    mutateJsonl(join(root, "knowledge/index.jsonl"), (records) => {
      const record = records.find((entry) => entry.knowledgeId === "k-fixture-topic");
      if (record === undefined) throw new Error("找不到測試用的知識記錄");
      const versions = record.versions as Record<string, unknown>[];
      const version = versions.find((entry) => entry.version === 1);
      if (version === undefined) throw new Error("找不到測試用的知識版本");
      version.sha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
      version.bytes = Buffer.byteLength(body, "utf8");
    });

    expectPackageError(() => validatePackage(root), "TIMESTAMP_IN_CONTENT");
  });

  test("知識檔案內容與索引雜湊不符被拒絕", () => {
    const root = copyExamplePackage();
    const bodyPath = join(root, "knowledge/files/k-export-format/v2.md");
    writeFileSync(bodyPath, `${readFileSync(bodyPath, "utf8")}遭到修改\n`, "utf8");

    expectPackageError(() => validatePackage(root), "KNOWLEDGE_HASH_MISMATCH");
  });

  test("raw 檔案內容與 mapping 雜湊不符被拒絕", () => {
    const root = copyExamplePackage();
    const rawPath = join(root, "raw/project/tasks.json");
    writeFileSync(rawPath, `${readFileSync(rawPath, "utf8")}遭到修改\n`, "utf8");

    expectPackageError(() => validatePackage(root), "RAW_HASH_MISMATCH");
  });
});

describe("匯出內容的可重跑性", () => {
  test("同一輸入重跑時內容檔案逐位元組相同", () => {
    const input = examplePackageInput();
    const first = makeTempDirectory();
    const second = makeTempDirectory();
    const firstCreatedAt = "2026-10-08T12:00:00.000Z";
    const secondCreatedAt = "2026-10-09T01:02:03.004Z";

    writePackage(first, input, firstCreatedAt);
    writePackage(second, input, secondCreatedAt);

    const firstContent = listFiles(first).filter((file) => file !== "manifest.json");
    const secondContent = listFiles(second).filter((file) => file !== "manifest.json");
    expect(secondContent).toEqual(firstContent);
    for (const file of firstContent) {
      expect(readFileSync(join(second, file))).toEqual(readFileSync(join(first, file)));
    }

    const firstManifest = readJson(join(first, "manifest.json"));
    const secondManifest = readJson(join(second, "manifest.json"));
    expect(secondManifest.createdAt).not.toBe(firstManifest.createdAt);

    delete firstManifest.createdAt;
    delete secondManifest.createdAt;
    expect(secondManifest).toEqual(firstManifest);
  });

  test("產生時間只出現在 manifest", () => {
    const root = makeTempDirectory();
    const createdAt = "2026-10-08T12:00:00.000Z";
    writePackage(root, examplePackageInput(), createdAt);

    for (const file of listFiles(root)) {
      if (file === "manifest.json" || file.startsWith("raw/")) continue;
      expect(readFileSync(join(root, file)).includes(Buffer.from(createdAt, "utf8"))).toBe(false);
    }
  });

  test("raw 檔案與輸入逐位元組相同", () => {
    const input = examplePackageInput();
    const root = makeTempDirectory();
    writePackage(root, input, "2026-10-08T12:00:00.000Z");

    for (const file of input.raw) {
      const actual = readFileSync(join(root, "raw", file.layer, file.path));
      const expected =
        typeof file.body === "string" ? Buffer.from(file.body, "utf8") : Buffer.from(file.body);
      expect(actual.equals(expected)).toBe(true);
    }
  });

  test("空匯出包可以通過驗證", () => {
    const input = {
      ...examplePackageInput(),
      work: [],
      events: [],
      evidence: [],
      signals: [],
      knowledge: [],
      mapping: [],
      raw: [],
    };
    const root = makeTempDirectory();
    writePackage(root, input, "2026-10-08T12:00:00.000Z");

    const pkg = validatePackage(root);
    expect(pkg.work).toHaveLength(0);
    expect(pkg.events).toHaveLength(0);
    expect(pkg.knowledge).toHaveLength(0);
    expect(pkg.rawFiles).toHaveLength(0);
  });
});
