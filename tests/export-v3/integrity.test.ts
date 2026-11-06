import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exportV3, PRODUCER_VERSION } from "../../src/export/v3/index.ts";
import { validatePackage } from "../export-format/helpers/package";
import {
  copyFixtureProject,
  copyGlobalFixture,
  hashTree,
  listRelativeFiles,
  makeTempDir,
  readJson,
  readJsonLines,
} from "./helpers/fixtures";

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = makeTempDir();
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function treeText(root: string, skipManifest = false): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const relative of listRelativeFiles(root)) {
    if (skipManifest && relative === "manifest.json") continue;
    result.set(relative, readFileSync(join(root, relative)));
  }
  return result;
}

describe("來源唯讀與 raw 完整性", () => {
  test("執行前後來源目錄的每個檔案 hash 不變", () => {
    const project = copyFixtureProject();
    const global = copyGlobalFixture();
    const beforeProject = hashTree(project.ultrawork);
    const beforeGlobal = hashTree(global);
    const out = join(tempDirectory(), "out");

    exportV3({ project: project.root, global, out });

    expect(hashTree(project.ultrawork)).toEqual(beforeProject);
    expect(hashTree(global)).toEqual(beforeGlobal);
  });

  test("raw/ 的每個檔案和來源逐位元組相同", () => {
    const project = copyFixtureProject();
    const global = copyGlobalFixture();
    const out = join(tempDirectory(), "out");

    exportV3({ project: project.root, global, out });

    for (const relative of listRelativeFiles(project.ultrawork)) {
      const source = readFileSync(join(project.ultrawork, relative));
      const exported = readFileSync(join(out, "raw", "project", relative));
      expect(exported.equals(source)).toBe(true);
    }
    for (const relative of listRelativeFiles(global)) {
      const source = readFileSync(join(global, relative));
      const exported = readFileSync(join(out, "raw", "global", relative));
      expect(exported.equals(source)).toBe(true);
    }
  });

  test("二進位檔與不安全檔名會安全落地，內容仍逐位元組相同", () => {
    const project = copyFixtureProject();
    const assets = join(project.ultrawork, "assets");
    mkdirSync(assets, { recursive: true });
    const binary = new Uint8Array([0, 255, 1, 2, 128, 10, 13, 0]);
    writeFileSync(join(assets, "中文 檔名.bin"), binary);
    const out = join(tempDirectory(), "out");

    const result = exportV3({ project: project.root, out });
    validatePackage(out);

    const rawFiles = readJsonLines(join(out, "mapping.jsonl")).filter(
      (record) => record.entity === "raw",
    );
    const name = rawFiles
      .map((record) => String(record.targetId))
      .find((target) => target.endsWith(".bin"));
    expect(name).toBeDefined();
    expect(name).toMatch(/^raw\/project\/assets\/[A-Za-z0-9._-]+\.bin$/);

    const rawPath = join(out, name!);
    expect(readFileSync(rawPath).equals(Buffer.from(binary))).toBe(true);
    const mapping = rawFiles.find((record) => record.targetId === name);
    expect(String(mapping?.note)).toContain("中文 檔名.bin");
  });
});

describe("可重跑", () => {
  test("producer 版本和 package.json 一致", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(PRODUCER_VERSION).toBe(packageJson.version);
  });
  test("同一輸入跑兩次，除 manifest.createdAt 外所有輸出相同", () => {
    const project = copyFixtureProject();
    const global = copyGlobalFixture();
    const first = join(tempDirectory(), "first");
    const second = join(tempDirectory(), "second");

    exportV3({ project: project.root, global, out: first, now: () => new Date("2026-01-01T00:00:00.000Z") });
    exportV3({ project: project.root, global, out: second, now: () => new Date("2026-02-02T00:00:00.000Z") });

    const firstTree = treeText(first, true);
    const secondTree = treeText(second, true);
    expect([...firstTree.keys()].sort()).toEqual([...secondTree.keys()].sort());
    for (const [relative, bytes] of firstTree) {
      expect(secondTree.get(relative)?.equals(bytes)).toBe(true);
    }

    const firstManifest = readJson(join(first, "manifest.json"));
    const secondManifest = readJson(join(second, "manifest.json"));
    expect(firstManifest.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(secondManifest.createdAt).toBe("2026-02-02T00:00:00.000Z");
    const { createdAt: _firstCreatedAt, ...firstRest } = firstManifest;
    const { createdAt: _secondCreatedAt, ...secondRest } = secondManifest;
    expect(secondRest).toEqual(firstRest);
  });

  test("輸出檔案的 sha256 和 mapping、knowledge 索引一致", () => {
    const project = copyFixtureProject();
    const out = join(tempDirectory(), "out");
    exportV3({ project: project.root, out });

    for (const mapping of readJsonLines(join(out, "mapping.jsonl"))) {
      if (mapping.entity !== "raw") continue;
      const bytes = readFileSync(join(out, String(mapping.targetId)));
      const hash = createHash("sha256").update(bytes).digest("hex");
      expect(mapping.sha256).toBe(hash);
    }
    for (const entry of readJsonLines(join(out, "knowledge/index.jsonl"))) {
      const versions = entry.versions as Array<Record<string, unknown>>;
      for (const version of versions) {
        const bytes = readFileSync(join(out, String(version.path)));
        expect(version.bytes).toBe(bytes.byteLength);
        expect(version.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
    }
  });
});
