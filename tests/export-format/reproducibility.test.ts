import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { exampleFixtureDir, examplePackageInput } from "./helpers/fixture";
import { validatePackage } from "./helpers/package";
import { createTempDir } from "./helpers/temp";
import { writePackage } from "./helpers/writer";

function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

describe("同一輸入重跑", () => {
  test("內容檔案的 bytes 完全相同，只有 manifest.createdAt 不同", () => {
    const firstRoot = join(createTempDir(), "first");
    const secondRoot = join(createTempDir(), "second");
    const firstCreatedAt = "2026-01-01T00:00:00.000Z";
    const secondCreatedAt = "2026-02-02T12:34:56.789Z";

    writePackage(firstRoot, examplePackageInput(), firstCreatedAt);
    writePackage(secondRoot, examplePackageInput(), secondCreatedAt);

    validatePackage(firstRoot);
    validatePackage(secondRoot);

    const firstFiles = listFiles(firstRoot);
    const secondFiles = listFiles(secondRoot);
    expect(firstFiles).toEqual(secondFiles);

    for (const file of firstFiles) {
      const firstBytes = readFileSync(join(firstRoot, file));
      const secondBytes = readFileSync(join(secondRoot, file));
      if (file === "manifest.json") {
        expect(firstBytes.equals(secondBytes)).toBe(false);
        continue;
      }
      expect(firstBytes.equals(secondBytes)).toBe(true);
    }

    const firstManifest = JSON.parse(
      readFileSync(join(firstRoot, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    const secondManifest = JSON.parse(
      readFileSync(join(secondRoot, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(firstManifest.createdAt).toBe(firstCreatedAt);
    expect(secondManifest.createdAt).toBe(secondCreatedAt);

    delete firstManifest.createdAt;
    delete secondManifest.createdAt;
    expect(firstManifest).toEqual(secondManifest);
  });

  test("已提交的範例包與重新產生的內容檔逐位元組相同", () => {
    const fixture = exampleFixtureDir();
    const root = join(createTempDir(), "regenerated");
    writePackage(root, examplePackageInput(), "2027-01-01T00:00:00.000Z");

    const fixtureFiles = listFiles(fixture).filter((file) => file !== "manifest.json");
    const regeneratedFiles = listFiles(root).filter((file) => file !== "manifest.json");
    expect(regeneratedFiles).toEqual(fixtureFiles);
    for (const file of fixtureFiles) {
      expect(readFileSync(join(root, file)).equals(readFileSync(join(fixture, file)))).toBe(true);
    }
  });

  test("空檔案也維持穩定格式", () => {
    const root = join(createTempDir(), "empty-lines");
    writePackage(root, examplePackageInput(), "2026-03-03T03:03:03.003Z");

    for (const file of ["work.jsonl", "events.jsonl", "evidence.jsonl", "signals.jsonl"]) {
      const text = readFileSync(join(root, file), "utf8");
      if (text !== "") {
        expect(text.endsWith("\n")).toBe(true);
      }
    }
  });
});
