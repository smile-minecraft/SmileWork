import { describe, expect, test } from "bun:test";

import { exampleFixtureDir } from "./helpers/fixture";
import { validatePackage } from "./helpers/package";

describe("範例匯出包", () => {
  test("符合 v1 schema 與套件結構", () => {
    const pkg = validatePackage(exampleFixtureDir());

    expect(pkg.manifest.format).toBe("smilework-export");
    expect(pkg.manifest.formatVersion).toBe(1);
    expect(pkg.manifest.layout.manifest.path).toBe("manifest.json");
    expect(pkg.manifest.layout.knowledge.path).toBe("knowledge/");
    expect(pkg.manifest.layout.raw.path).toBe("raw/");
  });

  test("八個部分都有內容或空檔案", () => {
    const pkg = validatePackage(exampleFixtureDir());

    expect(pkg.work.map((record) => record.workId)).toEqual([
      "w-plan-main",
      "w-task-cancel",
      "w-task-format",
      "w-task-import",
      "w-task-legacy-title",
    ]);
    expect(pkg.events.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pkg.evidence.map((record) => record.evidenceId)).toEqual([
      "e-artifact-output",
      "e-review-format",
      "e-tests-format",
    ]);
    expect(pkg.signals.map((record) => record.signalId)).toEqual(["s-format-warning"]);
    expect(pkg.knowledge.map((record) => record.knowledgeId)).toEqual([
      "k-export-format",
      "k-fixture-topic",
      "k-shared-global",
      "k-shared-project",
    ]);
    expect(pkg.mapping.length).toBeGreaterThan(0);
    expect(pkg.rawFiles).toEqual([
      "global/memory/topics/fixture-topic.md",
      "global/memory/topics/shared-topic.md",
      "project/assets/blob.bin",
      "project/evidence/test-output.txt",
      "project/memory/topics/export-format-decision.md",
      "project/memory/topics/shared-topic.md",
      "project/tasks.json",
    ]);
  });

  test("manifest 的計數與實際內容一致", () => {
    const pkg = validatePackage(exampleFixtureDir());

    expect(pkg.manifest.layout.work.records).toBe(pkg.work.length);
    expect(pkg.manifest.layout.events.records).toBe(pkg.events.length);
    expect(pkg.manifest.layout.evidence.records).toBe(pkg.evidence.length);
    expect(pkg.manifest.layout.signals.records).toBe(pkg.signals.length);
    expect(pkg.manifest.layout.knowledge.entries).toBe(pkg.knowledge.length);
    expect(pkg.manifest.layout.knowledge.files).toBe(5);
    expect(pkg.manifest.layout.mapping.records).toBe(pkg.mapping.length);
    expect(pkg.manifest.layout.raw.files).toBe(pkg.rawFiles.length);
    expect(pkg.manifest.layout.raw.projectFiles).toBe(5);
    expect(pkg.manifest.layout.raw.globalFiles).toBe(2);
  });

  test("知識版本可以還原到目前版本", () => {
    const pkg = validatePackage(exampleFixtureDir());
    const exportFormat = pkg.knowledge.find((entry) => entry.knowledgeId === "k-export-format");

    expect(exportFormat).toBeDefined();
    expect(exportFormat?.currentVersion).toBe(2);
    expect(exportFormat?.versions.map((version) => version.version)).toEqual([1, 2]);
  });
});
