import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  EventRecord,
  EvidenceRecord,
  KnowledgeInput,
  KnowledgeRecord,
  Manifest,
  MappingRecord,
  PackageInput,
  RawFileInput,
  SignalRecord,
  WorkRecord,
} from "./types";

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareStrings)) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(sortKeysDeep(value));
  if (text === undefined) {
    throw new Error("無法序列化非 JSON 值");
  }
  return text;
}

export function canonicalJsonPretty(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLength(body: string | Uint8Array): number {
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
}

function assertSafeRelativePath(path: string, label: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} 不是安全相對路徑：${path}`);
  }
}

export function writeJsonLinesFile(path: string, records: readonly unknown[]): void {
  const body = records.map((record) => canonicalJson(record)).join("\n");
  writeFileSync(path, records.length === 0 ? "" : `${body}\n`, "utf8");
}

function sortedWork(records: readonly WorkRecord[]): WorkRecord[] {
  return [...records]
    .sort((left, right) => compareStrings(left.workId, right.workId))
    .map((record) => {
      const next = { ...record };
      for (const key of ["dependsOn", "nonGoals", "contextRefs", "scopePaths"] as const) {
        const value = next[key];
        if (value !== undefined) next[key] = [...value].sort(compareStrings);
      }
      return next;
    });
}

function sortedEvents(records: readonly EventRecord[]): EventRecord[] {
  return [...records].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return compareStrings(left.eventId, right.eventId);
  });
}

function sortEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...records].sort((left, right) =>
    compareStrings(left.evidenceId, right.evidenceId),
  );
}

function sortSignals(records: readonly SignalRecord[]): SignalRecord[] {
  return [...records].sort((left, right) =>
    compareStrings(left.signalId, right.signalId),
  );
}

function sortMappings(records: readonly MappingRecord[]): MappingRecord[] {
  return [...records].sort((left, right) => {
    const entityOrder = compareStrings(left.entity, right.entity);
    if (entityOrder !== 0) return entityOrder;
    const layerOrder = compareStrings(left.layer, right.layer);
    if (layerOrder !== 0) return layerOrder;
    const sourceOrder = compareStrings(left.sourceId, right.sourceId);
    if (sourceOrder !== 0) return sourceOrder;
    return compareStrings(left.targetId, right.targetId);
  });
}

function materializeKnowledge(
  root: string,
  input: KnowledgeInput,
): { record: KnowledgeRecord; files: number } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.knowledgeId)) {
    throw new Error(`knowledgeId 不是安全路徑識別碼：${input.knowledgeId}`);
  }
  const versions = [...input.versions]
    .sort((left, right) => left.version - right.version)
    .map((version) => {
      const relativePath = `knowledge/files/${input.knowledgeId}/v${version.version}.md`;
      const absolutePath = join(root, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, version.body, "utf8");
      return {
        version: version.version,
        path: relativePath,
        sha256: sha256Text(version.body),
        bytes: byteLength(version.body),
      };
    });

  const record: KnowledgeRecord = {
    knowledgeId: input.knowledgeId,
    type: input.type,
    layer: input.layer,
    title: input.title,
    description: input.description,
    pinned: input.pinned,
    source: input.source,
    versions,
    currentVersion: input.currentVersion,
  };
  if (input.workId !== undefined) record.workId = input.workId;
  if (input.tags !== undefined) record.tags = [...input.tags].sort(compareStrings);

  return { record, files: versions.length };
}

function materializeRaw(
  root: string,
  files: readonly RawFileInput[],
): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of [...files].sort((left, right) => {
    const layerOrder = compareStrings(left.layer, right.layer);
    if (layerOrder !== 0) return layerOrder;
    return compareStrings(left.path, right.path);
  })) {
    if (file.layer !== "project" && file.layer !== "global") {
      throw new Error(`raw layer 不合法：${String(file.layer)}`);
    }
    assertSafeRelativePath(file.path, "raw 檔案路徑");
    const relativePath = `raw/${file.layer}/${file.path}`;
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    if (typeof file.body === "string") {
      writeFileSync(absolutePath, file.body, "utf8");
    } else {
      writeFileSync(absolutePath, file.body);
    }
    hashes.set(relativePath, sha256Bytes(typeof file.body === "string" ? Buffer.from(file.body, "utf8") : file.body));
  }
  return hashes;
}

function fillRawMappingHashes(
  mappings: readonly MappingRecord[],
  rawHashes: ReadonlyMap<string, string>,
): MappingRecord[] {
  return mappings.map((mapping) => {
    if (mapping.entity !== "raw") return mapping;
    const hash = rawHashes.get(mapping.targetId);
    if (hash === undefined) {
      throw new Error(`raw 對應指向不存在的檔案：${mapping.targetId}`);
    }
    assertSafeRelativePath(mapping.targetId, "raw mapping targetId");
    const expectedRoot = mapping.layer === "project" ? "raw/project" : "raw/global";
    if (mapping.sourceRoot !== expectedRoot) {
      throw new Error(`raw mapping 的 sourceRoot 與 layer 不一致：${mapping.targetId}`);
    }
    if (!mapping.targetId.startsWith(`${expectedRoot}/`)) {
      throw new Error(`raw mapping 的 targetId 不在對應的來源根目錄：${mapping.targetId}`);
    }
    return { ...mapping, sha256: hash };
  });
}

export function writePackage(
  root: string,
  input: PackageInput,
  createdAt: string,
): Manifest {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "knowledge", "files"), { recursive: true });
  mkdirSync(join(root, "raw", "project"), { recursive: true });
  mkdirSync(join(root, "raw", "global"), { recursive: true });

  const work = sortedWork(input.work);
  const events = sortedEvents(input.events);
  const evidence = sortEvidence(input.evidence);
  const signals = sortSignals(input.signals);
  const knowledge = [...input.knowledge].sort((left, right) =>
    compareStrings(left.knowledgeId, right.knowledgeId),
  );

  writeJsonLinesFile(join(root, "work.jsonl"), work);
  writeJsonLinesFile(join(root, "events.jsonl"), events);
  writeJsonLinesFile(join(root, "evidence.jsonl"), evidence);
  writeJsonLinesFile(join(root, "signals.jsonl"), signals);

  const knowledgeRecords: KnowledgeRecord[] = [];
  let knowledgeFiles = 0;
  for (const entry of knowledge) {
    const materialized = materializeKnowledge(root, entry);
    knowledgeRecords.push(materialized.record);
    knowledgeFiles += materialized.files;
  }
  writeJsonLinesFile(join(root, "knowledge/index.jsonl"), knowledgeRecords);

  const rawHashes = materializeRaw(root, input.raw);
  const mapping = sortMappings(fillRawMappingHashes(input.mapping, rawHashes));
  writeJsonLinesFile(join(root, "mapping.jsonl"), mapping);

  const manifest: Manifest = {
    format: "smilework-export",
    formatVersion: 1,
    createdAt,
    producer: input.producer,
    source: input.source,
    layout: {
      manifest: { path: "manifest.json" },
      work: { path: "work.jsonl", records: work.length },
      events: { path: "events.jsonl", records: events.length },
      evidence: { path: "evidence.jsonl", records: evidence.length },
      signals: { path: "signals.jsonl", records: signals.length },
      knowledge: { path: "knowledge/", entries: knowledgeRecords.length, files: knowledgeFiles },
      mapping: { path: "mapping.jsonl", records: mapping.length },
      raw: {
        path: "raw/",
        files: input.raw.length,
        projectFiles: input.raw.filter((file) => file.layer === "project").length,
        globalFiles: input.raw.filter((file) => file.layer === "global").length,
      },
    },
    warnings: input.warnings ?? [],
  };

  writeFileSync(join(root, "manifest.json"), canonicalJsonPretty(manifest), "utf8");
  return manifest;
}
