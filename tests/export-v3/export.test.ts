import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ExportV3Error } from "../../src/export/v3/errors.ts";
import { exportV3 } from "../../src/export/v3/index.ts";
import type { Manifest, MappingRecord } from "../export-format/helpers/types";
import { validatePackage } from "../export-format/helpers/package";
import {
  FIXED_CREATED_AT,
  copyFixture,
  listFiles,
  makeTempDir,
  readJson,
  removeDir,
  scanHashes,
  sha256File,
} from "./helpers/fixture";

function targetIdFor(
  mappings: readonly MappingRecord[],
  entity: MappingRecord["entity"],
  layer: MappingRecord["layer"],
  sourceId: string,
): string {
  const mapping = mappings.find(
    (candidate) =>
      candidate.entity === entity && candidate.layer === layer && candidate.sourceId === sourceId,
  );
  if (mapping === undefined) {
    throw new Error(`找不到 ${entity}/${layer}/${sourceId} 的 mapping`);
  }
  return mapping.targetId;
}

function readManifest(root: string): Manifest {
  return readJson(join(root, "manifest.json")) as unknown as Manifest;
}

function expectSourcesUnchanged(before: Map<string, string>, source: string): void {
  expect(Object.fromEntries(scanHashes(source))).toEqual(Object.fromEntries(before));
}

function expectRawBytesMatch(
  root: string,
  mappings: readonly MappingRecord[],
  layers: { project: string; global?: string },
): void {
  const rawMappings = mappings.filter((mapping) => mapping.entity === "raw");
  expect(rawMappings.length).toBeGreaterThan(0);
  for (const mapping of rawMappings) {
    const sourceRoot = mapping.layer === "project" ? layers.project : layers.global;
    if (sourceRoot === undefined) {
      throw new Error(`mapping 指向不存在的 ${mapping.layer} 層`);
    }
    const sourceBytes = readFileSync(join(sourceRoot, mapping.sourceId));
    const packageBytes = readFileSync(join(root, mapping.targetId));
    expect(packageBytes.equals(sourceBytes)).toBe(true);
    expect(mapping.sha256).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
  }
}

describe("v3 匯出器", () => {
  test("fixture 匯出成合法套件，來源不變，raw 逐位元組相同", () => {
    const project = copyFixture("v2-data");
    const out = join(makeTempDir("out"), "package");
    try {
      const before = scanHashes(project);
      const result = exportV3({
        project,
        out,
        producerVersion: "0.1.0",
        createdAt: FIXED_CREATED_AT,
      });

      expectSourcesUnchanged(before, project);
      expect(result.manifest.format).toBe("smilework-export");
      expect(result.manifest.formatVersion).toBe(1);
      expect(result.manifest.source.kind).toBe("ultrawork-v3");
      expect(result.manifest.source.projectId).toBe("project");
      expect(result.manifest.source.layers).toEqual(["project"]);

      const pkg = validatePackage(out);
      expect(pkg.manifest.createdAt).toBe(FIXED_CREATED_AT);
      expect(pkg.work.some((work) => work.kind === "plan")).toBe(true);
      expect(pkg.knowledge.some((entry) => entry.title === "Fixture 測試主題")).toBe(true);

      expectRawBytesMatch(out, pkg.mapping, { project });

      const activeId = targetIdFor(pkg.mapping, "work", "project", "t-fixture-active");
      const active = pkg.work.find((work) => work.workId === activeId);
      expect(active?.status).toBe("in_progress");
      expect(active?.resolution).toBeUndefined();

      const doneId = targetIdFor(pkg.mapping, "work", "project", "t-fixture-done");
      const done = pkg.work.find((work) => work.workId === doneId);
      expect(done?.status).toBe("cancelled");
      expect(done?.resolution).toBe("abandoned");

      const planId = targetIdFor(pkg.mapping, "work", "project", "p-fixture-20261007");
      const plan = pkg.work.find((work) => work.workId === planId);
      expect(plan?.kind).toBe("plan");
      expect(plan?.status).toBe("in_progress");
      expect(active?.planId).toBe(planId);

      const activeEvents = pkg.events.filter((event) => event.workId === activeId);
      expect(activeEvents.length).toBeGreaterThanOrEqual(3);
      expect(
        activeEvents.some(
          (event) =>
            event.kind === "status_changed" &&
            event.toStatus === "in_progress" &&
            event.details?.legacy === true &&
            event.details?.source === "history",
        ),
      ).toBe(true);

      const knowledgeId = targetIdFor(pkg.mapping, "knowledge", "project", "fixture-topic");
      const knowledge = pkg.knowledge.find((entry) => entry.knowledgeId === knowledgeId);
      expect(knowledge?.type).toBe("reference");
      expect(knowledge?.layer).toBe("project");
      expect(knowledge?.pinned).toBe(false);
      expect(knowledge?.currentVersion).toBe(1);
      const versionPath = knowledge?.versions[0]?.path;
      expect(versionPath).toBeDefined();
      const body = readFileSync(join(out, versionPath!), "utf8");
      expect(body).toContain("fixturemarker");
      expect(body.startsWith("---")).toBe(false);

      expect(pkg.signals).toEqual([]);
      expect(
        pkg.manifest.warnings.some((warning) =>
          warning.includes("UNMAPPED_USAGE: project/memory/usage.json"),
        ),
      ).toBe(true);
    } finally {
      removeDir(project);
      removeDir(join(out, ".."));
    }
  });

  test("同一輸入重跑兩次，除 manifest.createdAt 外輸出相同", () => {
    const project = copyFixture("v2-data");
    const parent = makeTempDir("determinism");
    const first = join(parent, "first");
    const second = join(parent, "second");
    try {
      exportV3({ project, out: first, producerVersion: "0.1.0" });
      exportV3({ project, out: second, producerVersion: "0.1.0" });

      expect(listFiles(second)).toEqual(listFiles(first));
      for (const relative of listFiles(first)) {
        if (relative === "manifest.json") continue;
        expect(readFileSync(join(second, relative)).equals(readFileSync(join(first, relative)))).toBe(
          true,
        );
      }

      const firstManifest = readManifest(first);
      const secondManifest = readManifest(second);
      delete (firstManifest as { createdAt?: string }).createdAt;
      delete (secondManifest as { createdAt?: string }).createdAt;
      expect(secondManifest).toEqual(firstManifest);
    } finally {
      removeDir(project);
      removeDir(parent);
    }
  });

  test("同時有專案層與全域層時，同名路徑不會互相覆蓋", () => {
    const project = copyFixture("v2-data");
    const global = copyFixture("v2-global");
    const parent = makeTempDir("global");
    const out = join(parent, "package");
    try {
      const projectBefore = scanHashes(project);
      const globalBefore = scanHashes(global);
      const result = exportV3({
        project,
        global,
        out,
        producerVersion: "0.1.0",
        createdAt: FIXED_CREATED_AT,
      });

      expectSourcesUnchanged(projectBefore, project);
      expectSourcesUnchanged(globalBefore, global);
      expect(result.manifest.source.layers).toEqual(["project", "global"]);

      const pkg = validatePackage(out);
      const projectKnowledge = targetIdFor(
        pkg.mapping,
        "knowledge",
        "project",
        "fixture-topic",
      );
      const globalKnowledge = targetIdFor(pkg.mapping, "knowledge", "global", "fixture-topic");
      expect(projectKnowledge).not.toBe(globalKnowledge);
      expect(pkg.knowledge.find((entry) => entry.knowledgeId === globalKnowledge)?.layer).toBe(
        "global",
      );

      const projectRaw = pkg.mapping.find(
        (mapping) =>
          mapping.entity === "raw" &&
          mapping.layer === "project" &&
          mapping.sourceId === "memory/topics/fixture-topic.md",
      );
      const globalRaw = pkg.mapping.find(
        (mapping) =>
          mapping.entity === "raw" &&
          mapping.layer === "global" &&
          mapping.sourceId === "memory/topics/fixture-topic.md",
      );
      expect(projectRaw?.targetId).not.toBe(globalRaw?.targetId);
      expect(readFileSync(join(out, projectRaw!.targetId)).equals(readFileSync(join(project, projectRaw!.sourceId)))).toBe(true);
      expect(readFileSync(join(out, globalRaw!.targetId)).equals(readFileSync(join(global, globalRaw!.sourceId)))).toBe(true);
      expect(pkg.manifest.layout.raw.projectFiles).toBeGreaterThan(0);
      expect(pkg.manifest.layout.raw.globalFiles).toBeGreaterThan(0);
      expect(pkg.manifest.layout.raw.files).toBe(
        pkg.manifest.layout.raw.projectFiles + pkg.manifest.layout.raw.globalFiles,
      );
    } finally {
      removeDir(project);
      removeDir(global);
      removeDir(parent);
    }
  });

  test("未知欄位、未知狀態與未知檔案只記警告，不中斷整包", () => {
    const project = copyFixture("v2-data");
    const parent = makeTempDir("unknown");
    const out = join(parent, "package");
    try {
      const tasks = readJson(join(project, "tasks.json")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      tasks.tasks["t-fixture-active"]!.unknownField = "keep-me-in-raw";
      tasks.tasks["t-fixture-weird"] = {
        taskId: "t-fixture-weird",
        projectId: "project",
        projectPath: "/fixture-placeholder/project",
        title: "未知狀態任務",
        state: "SOMEDAY",
        owner: "fixture-owner",
        priority: "medium",
        updatedAt: "2026-10-07T18:01:27.300Z",
        history: [],
      };
      tasks.tasks["t-fixture-untitled"] = {
        taskId: "t-fixture-untitled",
        projectId: "project",
        projectPath: "/fixture-placeholder/project",
        state: "NEW",
        owner: "fixture-owner",
        priority: "medium",
        updatedAt: "2026-10-07T18:01:27.301Z",
        history: [],
      };
      writeFileSync(join(project, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);

      mkdirSync(join(project, "extras"), { recursive: true });
      writeFileSync(join(project, "extras", "unknown.bin"), Buffer.from([0, 1, 2, 255]));

      writeFileSync(
        join(project, "audit.jsonl"),
        [
          JSON.stringify({
            at: "2026-10-07T18:01:27.310Z",
            event: "risk-declared",
            taskId: "t-fixture-active",
            projectId: "project",
            actor: "arch",
            phase: "create",
            risk: "high",
          }),
          JSON.stringify({
            at: "2026-10-07T18:01:27.311Z",
            event: "review",
            taskId: "t-fixture-active",
            projectId: "project",
            actor: "momus",
            verdict: "approve",
            reviewer: "momus",
            note: "同意",
          }),
          JSON.stringify({
            at: "2026-10-07T18:01:27.312Z",
            event: "terminal",
            taskId: "t-fixture-active",
            projectId: "project",
            actor: "arch",
            finalState: "COMPLETED",
            risk: "high",
            reviewVerdict: "approve",
          }),
          "",
        ].join("\n"),
      );

      const result = exportV3({
        project,
        out,
        producerVersion: "0.1.0",
        createdAt: FIXED_CREATED_AT,
      });
      const warnings = result.manifest.warnings;
      expect(warnings.some((warning) => warning.startsWith("UNMAPPED_TASK_FIELD:"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("SOMEDAY"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("UNMAPPED_SOURCE_FILE"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("LEGACY_TITLE_FALLBACK"))).toBe(true);

      const pkg = validatePackage(out);
      expect(() => targetIdFor(pkg.mapping, "work", "project", "t-fixture-weird")).toThrow();

      const untitledId = targetIdFor(pkg.mapping, "work", "project", "t-fixture-untitled");
      const untitled = pkg.work.find((work) => work.workId === untitledId);
      expect(untitled?.title).toBe(untitledId);
      expect(warnings).toContain(`LEGACY_TITLE_FALLBACK: ${untitledId}`);

      const activeId = targetIdFor(pkg.mapping, "work", "project", "t-fixture-active");
      const auditEvents = pkg.events.filter(
        (event) => event.workId === activeId && event.details?.source === "audit",
      );
      expect(auditEvents.length).toBe(3);
      expect(auditEvents.some((event) => event.kind === "reviewed")).toBe(true);
      expect(auditEvents.some((event) => event.kind === "status_changed" && event.toStatus === "done")).toBe(
        true,
      );

      const unmappedSignal = pkg.signals.find((signal) => signal.code === "UNMAPPED_STATUS");
      expect(unmappedSignal).toBeDefined();

      const extra = pkg.mapping.find(
        (mapping) => mapping.entity === "raw" && mapping.sourceId === "extras/unknown.bin",
      );
      expect(extra).toBeDefined();
      expect(readFileSync(join(out, extra!.targetId)).equals(readFileSync(join(project, "extras", "unknown.bin")))).toBe(
        true,
      );
    } finally {
      removeDir(project);
      removeDir(parent);
    }
  });

  test("技能草稿會變成 knowledge 文件，附屬檔案留在 raw", () => {
    const project = copyFixture("v2-data");
    const parent = makeTempDir("skill");
    const out = join(parent, "package");
    try {
      mkdirSync(join(project, "skill-drafts", "demo-skill"), { recursive: true });
      writeFileSync(
        join(project, "skill-drafts", "demo-skill", "SKILL.md"),
        "---\nname: demo-skill\ndescription: 示範技能\n---\n\n# Demo\n\n內容\n",
      );
      writeFileSync(join(project, "skill-drafts", "demo-skill", "extra.txt"), "asset\n");

      exportV3({ project, out, producerVersion: "0.1.0", createdAt: FIXED_CREATED_AT });
      const pkg = validatePackage(out);
      const knowledgeId = targetIdFor(
        pkg.mapping,
        "knowledge",
        "project",
        "skill-drafts/demo-skill/SKILL.md",
      );
      const knowledge = pkg.knowledge.find((entry) => entry.knowledgeId === knowledgeId);
      expect(knowledge?.type).toBe("document");
      expect(knowledge?.title).toBe("demo-skill");
      expect(knowledge?.description).toBe("示範技能");
      const body = readFileSync(join(out, knowledge!.versions[0]!.path), "utf8");
      expect(body).toContain("# Demo");
      expect(body.startsWith("---")).toBe(false);

      const asset = pkg.mapping.find(
        (mapping) => mapping.entity === "raw" && mapping.sourceId === "skill-drafts/demo-skill/extra.txt",
      );
      expect(asset).toBeDefined();
    } finally {
      removeDir(project);
      removeDir(parent);
    }
  });

  test("缺少可辨識的來源時回報明確錯誤，且不留下半套輸出", () => {
    const project = makeTempDir("empty");
    const parent = makeTempDir("missing");
    const out = join(parent, "package");
    try {
      let error: unknown;
      try {
        exportV3({ project, out, producerVersion: "0.1.0" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ExportV3Error);
      expect((error as ExportV3Error).code).toBe("NOT_ULTRAWORK_SOURCE");
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      removeDir(project);
      removeDir(parent);
    }
  });

  test("輸出位置包含來源時拒絕，避免取代時刪掉來源", () => {
    const parent = makeTempDir("contains");
    const source = join(parent, ".ultrawork");
    try {
      cpSync(join(import.meta.dir, "fixtures", "v2-data"), source, { recursive: true });
      let error: unknown;
      try {
        exportV3({ project: parent, out: parent, force: true, producerVersion: "0.1.0" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ExportV3Error);
      expect((error as ExportV3Error).code).toBe("OUTPUT_CONTAINS_SOURCE");
      expect(existsSync(join(source, "tasks.json"))).toBe(true);
    } finally {
      removeDir(parent);
    }
  });

  test("來源 registry 損壞時記警告，仍然產生完整套件並保留原始位元組", () => {
    const project = copyFixture("v2-data");
    const parent = makeTempDir("broken");
    const out = join(parent, "package");
    const broken = "{ not json\r\n";
    try {
      writeFileSync(join(project, "tasks.json"), broken);
      const result = exportV3({
        project,
        out,
        producerVersion: "0.1.0",
        createdAt: FIXED_CREATED_AT,
      });
      expect(result.manifest.warnings.some((warning) => warning.includes("REGISTRY_PARSE_ERROR"))).toBe(
        true,
      );
      const pkg = validatePackage(out);
      expect(pkg.work.every((work) => work.kind === "plan")).toBe(true);
      const raw = pkg.mapping.find(
        (mapping) => mapping.entity === "raw" && mapping.sourceId === "tasks.json",
      );
      expect(raw).toBeDefined();
      expect(readFileSync(join(out, raw!.targetId), "utf8")).toBe(broken);
    } finally {
      removeDir(project);
      removeDir(parent);
    }
  });
});
