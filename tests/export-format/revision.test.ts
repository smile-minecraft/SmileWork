import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exampleFixtureDir, examplePackageInput } from "./helpers/fixture";
import { readJsonl, validatePackage } from "./helpers/package";
import { validateRecordSchema } from "./helpers/schemas";
import { captureValidationError, copyExamplePackage, createTempDir } from "./helpers/temp";
import type {
  EvidenceRecord,
  KnowledgeInput,
  MappingRecord,
  PackageInput,
  WorkRecord,
} from "./helpers/types";
import { writeJsonLinesFile, writePackage } from "./helpers/writer";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const repoRoot = join(import.meta.dir, "..", "..");

function baseInput(): PackageInput {
  return {
    producer: { name: "smilework", version: "0.1.0" },
    source: {
      kind: "ultrawork-v3",
      projectId: "revision-fixture",
      layers: ["project", "global"],
    },
    warnings: [],
    work: [],
    events: [],
    evidence: [],
    signals: [],
    knowledge: [],
    mapping: [],
    raw: [],
  };
}

function rawMapping(
  layer: "project" | "global",
  path: string,
): MappingRecord {
  const sourceRoot = layer === "project" ? "raw/project" : "raw/global";
  return {
    entity: "raw",
    layer,
    sourceRoot,
    sourceId: path,
    targetId: `${sourceRoot}/${path}`,
    sourceRef: `${sourceRoot}/${path}`,
  };
}

function packageWithRaw(
  raw: PackageInput["raw"],
  mapping: PackageInput["mapping"],
): PackageInput {
  return { ...baseInput(), raw, mapping };
}

describe("raw 與 mapping 的專案層／全域層分層", () => {
  test("同相對路徑的 project 與 global raw 不碰撞", () => {
    const input = packageWithRaw(
      [
        { layer: "project", path: "memory/topics/shared-topic.md", body: "project\n" },
        { layer: "global", path: "memory/topics/shared-topic.md", body: "global\n" },
      ],
      [
        rawMapping("project", "memory/topics/shared-topic.md"),
        rawMapping("global", "memory/topics/shared-topic.md"),
      ],
    );
    const root = join(createTempDir(), "layered");
    writePackage(root, input, CREATED_AT);

    const pkg = validatePackage(root);

    expect(pkg.rawFiles).toEqual([
      "global/memory/topics/shared-topic.md",
      "project/memory/topics/shared-topic.md",
    ]);
    expect([...new Set(pkg.mapping.map((record) => record.layer))].sort()).toEqual([
      "global",
      "project",
    ]);
    expect(pkg.mapping.map((record) => record.sourceRoot).sort()).toEqual([
      "raw/global",
      "raw/project",
    ]);
  });
});

describe("manifest 的來源層", () => {
  test("缺少 source.layers 會被拒絕", () => {
    const root = copyExamplePackage();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      source: Record<string, unknown>;
    };
    delete manifest.source.layers;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MANIFEST_INVALID");
  });
});

describe("legacy work 的 title fallback", () => {
  test("缺少 title 的工作以 workId 當標題並留下 warning", () => {
    const input = examplePackageInput();
    const legacy = input.work.find((record) => record.workId === "w-task-legacy-title");

    expect(legacy).toBeDefined();
    expect(legacy?.title).toBe("w-task-legacy-title");
    expect(input.warnings).toContain("LEGACY_TITLE_FALLBACK: w-task-legacy-title");
  });
});

describe("work 的 v3 欄位", () => {
  const work: WorkRecord = {
    workId: "w-revision",
    kind: "task",
    title: "修訂匯出格式",
    status: "in_progress",
    owner: "build",
    priority: "high",
    planId: "w-plan",
    objective: "讓匯出格式能承載 v3 的規劃與驗收資料。",
    nonGoals: ["不改動來源資料"],
    contextRefs: ["knowledge:k-export-format", "raw/project/tasks.json"],
    scopePaths: ["docs/export-format-v1.md", "schemas/export-v1"],
    acceptance: ["schema 接受合法欄位", "測試涵蓋不合法值"],
    risk: "high",
    review: {
      verdict: "approve",
      reviewer: "momus",
      note: "沒有必須先修的問題",
    },
    acceptanceResults: {
      recordedBy: "build",
      items: [
        { criterion: "schema 接受合法欄位", met: true, evidence: "bun test" },
        { criterion: "測試涵蓋不合法值", met: true },
      ],
    },
  };

  test("合法欄位通過 schema", () => {
    expect(validateRecordSchema("work", work)).toEqual([]);
  });

  test("不合法 risk、review、acceptanceResults 被拒絕", () => {
    expect(validateRecordSchema("work", { ...work, risk: "critical" }).length).toBeGreaterThan(0);
    expect(
      validateRecordSchema("work", {
        ...work,
        review: { verdict: "maybe", reviewer: "momus" },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateRecordSchema("work", {
        ...work,
        acceptanceResults: { items: work.acceptanceResults?.items ?? [] },
      }).length,
    ).toBeGreaterThan(0);
  });

  test("contextRefs 與 scopePaths 拒絕絕對路徑與 ..", () => {
    expect(validateRecordSchema("work", { ...work, contextRefs: ["/etc/passwd"] }).length).toBeGreaterThan(0);
    expect(validateRecordSchema("work", { ...work, contextRefs: ["raw/project/../secret"] }).length).toBeGreaterThan(0);
    expect(validateRecordSchema("work", { ...work, scopePaths: ["../outside"] }).length).toBeGreaterThan(0);
  });

  test("集合欄位排序，acceptance 保持原順序", () => {
    const input = packageWithRaw([], []);
    input.work = [
      {
        workId: "w-sort-arrays",
        kind: "task",
        title: "排序",
        status: "done",
        resolution: "completed",
        owner: "build",
        priority: "low",
        dependsOn: ["b", "a"],
        nonGoals: ["b", "a"],
        contextRefs: ["work:b", "work:a"],
        scopePaths: ["src/b", "src/a"],
        acceptance: ["第二項", "第一項"],
        acceptanceResults: {
          recordedBy: "build",
          items: [
            { criterion: "第二項", met: true },
            { criterion: "第一項", met: true },
          ],
        },
      },
    ];
    const root = join(createTempDir(), "sorted-arrays");
    writePackage(root, input, CREATED_AT);
    const records = readJsonl(join(root, "work.jsonl")) as WorkRecord[];

    expect(records[0]?.dependsOn).toEqual(["a", "b"]);
    expect(records[0]?.nonGoals).toEqual(["a", "b"]);
    expect(records[0]?.contextRefs).toEqual(["work:a", "work:b"]);
    expect(records[0]?.scopePaths).toEqual(["src/a", "src/b"]);
    expect(records[0]?.acceptance).toEqual(["第二項", "第一項"]);
    expect(records[0]?.acceptanceResults?.items.map((item) => item.criterion)).toEqual([
      "第二項",
      "第一項",
    ]);
  });

  test("acceptanceResults 與 acceptance 逐項對齊", () => {
    const input = packageWithRaw([], []);
    input.work = [
      {
        ...work,
        status: "done",
        resolution: "completed",
        acceptance: ["第一項", "第二項"],
        acceptanceResults: {
          recordedBy: "build",
          items: [{ criterion: "第一項", met: true }],
        },
      },
    ];
    const root = join(createTempDir(), "acceptance");
    writePackage(root, input, CREATED_AT);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("ACCEPTANCE_RESULTS_MISMATCH");
  });
});

describe("mapping 的來源定位與安全", () => {
  const workMapping: MappingRecord = {
    entity: "work",
    layer: "project",
    sourceRoot: "raw/project",
    sourceId: "t-old-format",
    sourceRecord: "/tasks/t-old-format",
    targetId: "w-task-format",
    sourceRef: "raw/project/tasks.json",
  };

  test("合法的 sourceRef 與 sourceRecord 通過 schema", () => {
    expect(validateRecordSchema("mapping", workMapping)).toEqual([]);
  });

  test("sourceRef 拒絕絕對路徑與 ..", () => {
    expect(
      validateRecordSchema("mapping", { ...workMapping, sourceRef: "/etc/passwd" }).length,
    ).toBeGreaterThan(0);
    expect(
      validateRecordSchema("mapping", {
        ...workMapping,
        sourceRef: "raw/project/../secrets.json",
      }).length,
    ).toBeGreaterThan(0);
  });

  test("非 raw mapping 缺少 sourceRecord 會被拒絕", () => {
    const record = { ...workMapping };
    delete record.sourceRecord;

    expect(validateRecordSchema("mapping", record).length).toBeGreaterThan(0);
  });

  test("sourceRoot 與 layer 不一致會被拒絕", () => {
    expect(
      validateRecordSchema("mapping", { ...workMapping, sourceRoot: "raw/global" }).length,
    ).toBeGreaterThan(0);
  });

  test("sourceRef 指向不存在的套件檔案會被拒絕", () => {
    const input = packageWithRaw([], [workMapping]);
    const root = join(createTempDir(), "missing-source");
    writePackage(root, input, CREATED_AT);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("MAPPING_SOURCE_REF_MISSING");
  });
});

describe("canonical JSONL", () => {
  test("鍵沒有排序會被拒絕", () => {
    const root = copyExamplePackage();
    const path = join(root, "work.jsonl");
    const records = readJsonl(path) as Record<string, unknown>[];
    const first = records[0]!;
    records[0] = Object.fromEntries(Object.entries(first).reverse());
    writeFileSync(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("JSONL_NOT_CANONICAL");
  });

  test("緊湊 JSON 被加入空白會被拒絕", () => {
    const root = copyExamplePackage();
    const path = join(root, "work.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines[0] = lines[0]!.replace(":", ": ");
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("JSONL_NOT_CANONICAL");
  });

  test("記錄順序錯誤會被拒絕", () => {
    const root = copyExamplePackage();
    const path = join(root, "work.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").reverse();
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("JSONL_NOT_CANONICAL");
  });
});

describe("binary raw", () => {
  test("逐位元組保存並驗證", () => {
    const bytes = new Uint8Array([0, 255, 1, 2, 128, 10]);
    const input = packageWithRaw(
      [{ layer: "project", path: "assets/blob.bin", body: bytes }],
      [rawMapping("project", "assets/blob.bin")],
    );
    const root = join(createTempDir(), "binary");
    writePackage(root, input, CREATED_AT);

    const pkg = validatePackage(root);
    expect(pkg.rawFiles).toEqual(["project/assets/blob.bin"]);
    expect(readFileSync(join(root, "raw/project/assets/blob.bin")).equals(Buffer.from(bytes))).toBe(
      true,
    );

    const modified = new Uint8Array(bytes);
    modified[0] = 9;
    writeFileSync(join(root, "raw/project/assets/blob.bin"), modified);
    const error = captureValidationError(() => validatePackage(root));
    expect(error.code).toBe("RAW_HASH_MISMATCH");
  });
});

describe("套件發佈內容", () => {
  test("package.json 的 files 包含 schemas", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(pkg.files).toContain("schemas");
  });

  test("docs/README.md 連到匯出格式規格", () => {
    const readme = readFileSync(join(repoRoot, "docs/README.md"), "utf8");
    expect(readme).toContain("export-format-v1.md");
  });
});

describe("延後項目的已知風險", () => {
  test("evidence artifact 指到不存在的檔案會被拒絕", () => {
    const input = packageWithRaw(
      [{ layer: "project", path: "assets/present.bin", body: new Uint8Array([1]) }],
      [rawMapping("project", "assets/present.bin")],
    );
    input.work = [
      {
        workId: "w-evidence",
        kind: "task",
        title: "證據",
        status: "open",
        owner: "build",
        priority: "low",
      },
    ];
    const evidence: EvidenceRecord = {
      evidenceId: "e-artifact",
      workId: "w-evidence",
      kind: "artifact",
      actor: "build",
      summary: "不存在的檔案",
      path: "raw/project/assets/missing.bin",
    };
    input.evidence = [evidence];
    const root = join(createTempDir(), "evidence");
    writePackage(root, input, CREATED_AT);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("EVIDENCE_PATH_MISSING");
  });

  test("knowledge 版本號重複會被拒絕", () => {
    const input = packageWithRaw([], []);
    const knowledge: KnowledgeInput = {
      knowledgeId: "k-duplicate",
      type: "reference",
      layer: "project",
      title: "重複版本",
      description: "",
      pinned: false,
      source: "manual",
      currentVersion: 1,
      versions: [
        { version: 1, body: "first\n" },
        { version: 1, body: "second\n" },
      ],
    };
    input.knowledge = [knowledge];
    const root = join(createTempDir(), "duplicate-version");
    writePackage(root, input, CREATED_AT);

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("KNOWLEDGE_VERSION_DUPLICATE");
  });

  test("manifest.createdAt 必須是日曆上存在的日期", () => {
    const root = copyExamplePackage();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.createdAt = "2026-02-30T00:00:00.000Z";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const error = captureValidationError(() => validatePackage(root));

    expect(error.code).toBe("INVALID_TIMESTAMP");
  });
});
