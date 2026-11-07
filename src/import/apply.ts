import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Bytes } from "../export/v3/canonical.ts";
import { sha256Hex } from "../shared/hash.ts";
import { withImmediateTransaction } from "../db/transaction.ts";
import type {
  EvidenceRecord,
  ImportCounts,
  KnowledgeInput,
  Layer,
  MappingEntity,
  MappingRecord,
  PackageContents,
  WorkRecord,
} from "./types.ts";
import { WarningCollector } from "./warnings.ts";

const IMPORT_ACTOR = "import";

interface MappingInfo {
  layer: Layer;
  sourceId: string;
  sourceRecord: string | null;
  sourceRef: string | null;
  note: string | null;
}

interface ApplyOptions {
  projectId: string;
  home: string;
  now: () => Date;
  warnings: WarningCollector;
}

export interface ApplyResult {
  inserted: ImportCounts;
  skipped: ImportCounts;
}

function mappingIndex(contents: PackageContents): Map<string, MappingRecord> {
  const index = new Map<string, MappingRecord>();
  for (const mapping of contents.mapping) {
    const key = `${mapping.entity}\u0000${mapping.targetId}`;
    if (!index.has(key)) index.set(key, mapping);
  }
  return index;
}

function mappingInfo(
  index: ReadonlyMap<string, MappingRecord>,
  entity: MappingEntity,
  targetId: string,
  fallbackLayer: Layer = "project",
): MappingInfo {
  const mapping = index.get(`${entity}\u0000${targetId}`);
  return {
    layer: mapping?.layer ?? fallbackLayer,
    sourceId: mapping?.sourceId ?? targetId,
    sourceRecord: mapping?.sourceRecord ?? null,
    sourceRef: mapping?.sourceRef ?? null,
    note: mapping?.note ?? null,
  };
}

function sourceKey(projectId: string, sourceId: string): string {
  return `${projectId}\u0000${sourceId}`;
}

function findMapping(
  db: Database,
  entity: MappingEntity,
  layer: Layer,
  sourceId: string,
): { target_id: string; note: string | null } | null {
  return db
    .query<{ target_id: string; note: string | null }, [string, string, string]>(
      "SELECT target_id, note FROM id_mappings WHERE entity = ? AND layer = ? AND source_id = ?",
    )
    .get(entity, layer, sourceId);
}

function insertMapping(
  db: Database,
  row: {
    entity: MappingEntity;
    layer: Layer;
    sourceId: string;
    sourceRoot: string;
    sourceRecord: string | null;
    targetId: string;
    sourceRef: string | null;
    sha256: string | null;
    note: string | null;
    importedAt: string;
  },
): boolean {
  const result = db
    .query(
      `INSERT OR IGNORE INTO id_mappings (
         entity, layer, source_id, source_root, source_record, target_id,
         source_ref, sha256, note, imported_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.entity,
      row.layer,
      row.sourceId,
      row.sourceRoot,
      row.sourceRecord,
      row.targetId,
      row.sourceRef,
      row.sha256,
      row.note,
      row.importedAt,
    );
  return result.changes > 0;
}

function allocateId(
  db: Database,
  table: string,
  column: string,
  preferred: string,
  projectId: string,
  entity: string,
  sourceId: string,
  used: Set<string>,
): string {
  const isFree = (candidate: string): boolean => {
    if (used.has(candidate)) return false;
    const row = db
      .query<{ present: number }, [string]>(`SELECT 1 AS present FROM ${table} WHERE ${column} = ?`)
      .get(candidate);
    return row === null;
  };

  if (preferred !== "" && isFree(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const suffix = sha256Hex(`${projectId}\u0000${entity}\u0000${sourceId}`).slice(0, 8);
  const base = preferred === "" ? `${entity}-${suffix}` : `${preferred}-${suffix}`;
  let candidate = base;
  let counter = 2;
  while (!isFree(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function ensureProject(db: Database, contents: PackageContents, now: string): void {
  const projectId = contents.manifest.source.projectId;
  const existing = db
    .query<{ project_id: string }, [string]>("SELECT project_id FROM projects WHERE project_id = ?")
    .get(projectId);
  if (existing !== null) {
    db.query("UPDATE projects SET updated_at = ?, last_seen_at = ? WHERE project_id = ?").run(
      now,
      now,
      projectId,
    );
    return;
  }
  const synthetic = `import:${projectId}`;
  const rootPath = contents.manifest.source.projectPath ?? synthetic;
  try {
    db.query(
      `INSERT INTO projects (project_id, common_dir, root_path, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectId, synthetic, rootPath, now, now, now);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: projects.common_dir")) {
      db.query(
        `INSERT INTO projects (project_id, common_dir, root_path, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, `${synthetic}:${sha256Hex(projectId).slice(0, 8)}`, rootPath, now, now, now);
      return;
    }
    throw error;
  }
}

function writeFileAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${path.split("/").pop() ?? "file"}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`,
  );
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

function writeBlob(home: string, bytes: Uint8Array): string {
  const sha = sha256Bytes(bytes);
  const path = join(home, "blobs", sha.slice(0, 2), sha);
  if (existsSync(path)) {
    try {
      if (sha256Bytes(readFileSync(path)) === sha) return path;
    } catch {
      // 讀不到就重寫。
    }
  }
  writeFileAtomic(path, bytes);
  return path;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  return safe === "" ? sha256Hex(value).slice(0, 16) : safe;
}

function knowledgeSnapshotPath(
  home: string,
  projectId: string,
  entry: KnowledgeInput,
  version: number,
): string {
  const layerRoot = entry.record.layer === "global" ? "global" : safeSegment(projectId);
  return join(
    home,
    "knowledge-store",
    entry.record.layer,
    layerRoot,
    entry.record.knowledgeId,
    `v${version}.md`,
  );
}

function prepareRaw(
  contents: PackageContents,
  home: string,
  warnings: WarningCollector,
): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of contents.raw) {
    const absolute = join(contents.root, "raw", file.layer, file.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch (error) {
      warnings.add(`RAW_FILE_UNREADABLE raw/${file.layer}/${file.path}：${String(error)}`);
      continue;
    }
    const sha = sha256Bytes(bytes);
    hashes.set(`${file.layer}/${file.path}`, sha);
    writeBlob(home, bytes);
  }
  return hashes;
}

function rawMappingNotes(contents: PackageContents): Map<string, string> {
  const notes = new Map<string, string>();
  for (const mapping of contents.mapping) {
    if (mapping.entity !== "raw" || mapping.note === undefined) continue;
    const prefix = `raw/${mapping.layer}/`;
    if (!mapping.sourceRef.startsWith(prefix)) continue;
    const path = mapping.sourceRef.slice(prefix.length);
    const key = `${mapping.layer}/${path}`;
    if (!notes.has(key)) notes.set(key, mapping.note);
  }
  return notes;
}

function insertRawMappings(
  contents: PackageContents,
  db: Database,
  projectId: string,
  hashes: ReadonlyMap<string, string>,
  now: string,
  warnings: WarningCollector,
): number {
  const notes = rawMappingNotes(contents);
  let inserted = 0;
  for (const file of contents.raw) {
    const fileKey = `${file.layer}/${file.path}`;
    const sha = hashes.get(fileKey);
    if (sha === undefined) continue;
    const key = sourceKey(projectId, file.path);
    const note = notes.get(fileKey) ?? null;
    const existing = findMapping(db, "raw", file.layer, key);
    if (existing !== null) {
      if (existing.target_id !== sha) {
        warnings.add(`RAW_MAPPING_CONFLICT raw/${file.layer}/${file.path}`);
      }
      if (existing.note === null && note !== null) {
        db.query(
          "UPDATE id_mappings SET note = ? WHERE entity = 'raw' AND layer = ? AND source_id = ?",
        ).run(note, file.layer, key);
      }
      continue;
    }
    if (
      insertMapping(db, {
        entity: "raw",
        layer: file.layer,
        sourceId: key,
        sourceRoot: projectId,
        sourceRecord: null,
        targetId: sha,
        sourceRef: `raw/${file.layer}/${file.path}`,
        sha256: sha,
        note,
        importedAt: now,
      })
    ) {
      inserted += 1;
    }
  }
  return inserted;
}

function prepareKnowledge(
  contents: PackageContents,
  home: string,
  projectId: string,
  warnings: WarningCollector,
): Map<string, { path: string; sha256: string; bytes: number }> {
  const prepared = new Map<string, { path: string; sha256: string; bytes: number }>();
  for (const entry of contents.knowledge) {
    for (const version of entry.versions) {
      const absolute = knowledgeSnapshotPath(home, projectId, entry, version.version);
      const bytes = Buffer.from(version.body, "utf8");
      const sha = sha256Bytes(bytes);
      if (existsSync(absolute)) {
        try {
          if (sha256Bytes(readFileSync(absolute)) !== sha) {
            warnings.add(
              `KNOWLEDGE_SNAPSHOT_CONFLICT ${entry.record.knowledgeId} v${version.version}`,
            );
          }
        } catch {
          writeFileAtomic(absolute, bytes);
        }
      } else {
        writeFileAtomic(absolute, bytes);
      }
      prepared.set(`${entry.record.knowledgeId}\u0000${version.version}`, {
        path: absolute,
        sha256: sha,
        bytes: bytes.byteLength,
      });
    }
  }
  return prepared;
}

function knowledgeKind(record: KnowledgeInput["record"]): "memory" | "skill" | "document" {
  if (record.source.toLowerCase().startsWith("skill")) return "skill";
  if (record.type === "document") return "document";
  return "memory";
}

function signalKind(code: string): string {
  const upper = code.toUpperCase();
  if (upper.includes("REJECT")) return "review_reject";
  if (upper.includes("CORRECT")) return "correction";
  if (upper.includes("FIX")) return "fix";
  if (upper.includes("FAIL")) return "failure";
  if (upper.includes("DECISION")) return "decision";
  return "lesson";
}

function truncateCodePoints(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join("");
}

function jsonArray(values: readonly string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function workExists(db: Database, workId: string): boolean {
  return (
    db.query<{ present: number }, [string]>("SELECT 1 AS present FROM work_items WHERE work_id = ?").get(
      workId,
    ) !== null
  );
}

function insertWork(
  db: Database,
  projectId: string,
  targetId: string,
  record: WorkRecord,
  now: string,
): void {
  db.query(
    `INSERT INTO work_items (
       work_id, project_id, kind, title, status, resolution, owner, priority, plan_id,
       objective, non_goals, context_refs, scope_paths, acceptance, risk, review,
       reviewed_version, acceptance_results, version, created_at, updated_at,
       created_by, created_by_model, updated_by, updated_by_model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, NULL)`,
  ).run(
    targetId,
    projectId,
    record.kind,
    record.title,
    record.status,
    record.resolution ?? null,
    record.owner,
    record.priority,
    record.objective ?? null,
    jsonArray(record.nonGoals),
    jsonArray(record.contextRefs),
    jsonArray(record.scopePaths),
    jsonArray(record.acceptance),
    record.risk ?? null,
    jsonText(record.review),
    record.review === undefined ? null : 1,
    jsonText(record.acceptanceResults),
    now,
    now,
    IMPORT_ACTOR,
    IMPORT_ACTOR,
  );
}

function insertEvent(
  db: Database,
  projectId: string,
  targetId: string,
  sequence: number,
  record: PackageContents["events"][number],
  workId: string | null,
  now: string,
): void {
  db.query(
    `INSERT INTO events (
       event_id, project_id, sequence, kind, actor, actor_model, work_id,
       from_status, to_status, resolution, summary, details, created_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    targetId,
    projectId,
    sequence,
    record.kind,
    record.actor,
    workId,
    record.fromStatus ?? null,
    record.toStatus ?? null,
    record.resolution ?? null,
    record.summary ?? null,
    jsonText(record.details),
    now,
  );
}

function insertEvidence(
  db: Database,
  projectId: string,
  targetId: string,
  record: EvidenceRecord,
  workId: string,
  now: string,
): void {
  db.query(
    `INSERT INTO evidence (
       evidence_id, project_id, work_id, kind, actor, actor_model, summary,
       command, output, output_path, url, path, sha256, exit_code, duration_ms,
       server_issued, details, created_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
  ).run(
    targetId,
    projectId,
    workId,
    record.kind,
    record.actor,
    record.summary,
    record.command ?? null,
    record.output ?? null,
    record.url ?? null,
    record.path ?? null,
    record.sha256 ?? null,
    jsonText(record.details),
    now,
  );
}

function insertSignal(
  db: Database,
  projectId: string,
  targetId: string,
  record: PackageContents["signals"][number],
  workId: string | null,
  layer: Layer,
  now: string,
): void {
  const scope = record.scope ?? layer;
  db.query(
    `INSERT INTO signals (
       signal_id, project_id, scope, kind, content, status, work_id, refs,
       result_refs, reason, details, severity, code, actor, actor_model,
       created_at, updated_at, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    targetId,
    scope === "global" ? null : projectId,
    scope,
    signalKind(record.code),
    truncateCodePoints(record.message, 1000),
    record.status ?? "open",
    workId,
    JSON.stringify(record.refs ?? []),
    JSON.stringify(record.resultRefs ?? []),
    record.reason ?? null,
    jsonText(record.details),
    record.severity,
    record.code,
    IMPORT_ACTOR,
    now,
    now,
    IMPORT_ACTOR,
  );
}

function insertKnowledge(
  db: Database,
  projectId: string,
  targetKnowledgeId: string,
  entry: KnowledgeInput,
  prepared: ReadonlyMap<string, { path: string; sha256: string; bytes: number }>,
  workId: string | null,
  now: string,
): {
  entryId: number | bigint;
  insertedEntry: boolean;
  insertedVersions: number;
  versionConflicts: number[];
} {
  const record = entry.record;
  const projectScope = record.layer === "global" ? null : projectId;
  const existing = db
    .query<{ id: number }, [string, string, string | null]>(
      `SELECT id FROM knowledge_entries
        WHERE knowledge_id = ? AND layer = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
    )
    .get(targetKnowledgeId, record.layer, projectScope);

  let entryId: number | bigint;
  let insertedEntry = false;
  if (existing !== null) {
    entryId = existing.id;
  } else {
    const result = db
      .query(
        `INSERT INTO knowledge_entries (
           knowledge_id, layer, project_id, kind, type, title, description, pinned,
           source, tags, status, current_version, version, work_id,
           created_at, updated_at, created_by, created_by_model, updated_by, updated_by_model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        targetKnowledgeId,
        record.layer,
        projectScope,
        knowledgeKind(record),
        record.type,
        record.title,
        record.description,
        record.pinned ? 1 : 0,
        record.source,
        JSON.stringify(record.tags ?? []),
        record.currentVersion,
        workId,
        now,
        now,
        IMPORT_ACTOR,
        IMPORT_ACTOR,
      );
    entryId = result.lastInsertRowid;
    insertedEntry = true;
  }

  let insertedVersions = 0;
  const versionConflicts: number[] = [];
  for (const version of entry.versions) {
    const recordVersion = entry.record.versions.find(
      (candidate) => candidate.version === version.version,
    );
    if (recordVersion === undefined) continue;
    const existingVersion = db
      .query<{ sha256: string }, [number | bigint, number]>(
        "SELECT sha256 FROM knowledge_versions WHERE entry_id = ? AND version = ?",
      )
      .get(entryId, version.version);
    if (existingVersion !== null) {
      if (existingVersion.sha256 !== recordVersion.sha256) {
        // 版本不可覆寫；保留舊版並讓呼叫端記警告。
        versionConflicts.push(version.version);
      }
      continue;
    }
    const preparedVersion = prepared.get(
      `${entry.record.knowledgeId}\u0000${version.version}`,
    );
    if (preparedVersion === undefined) continue;
    db.query(
      `INSERT INTO knowledge_versions (
         entry_id, version, sha256, bytes, snapshot_path, actor, actor_model,
         reason, source_signal_ids, work_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?)`,
    ).run(
      entryId,
      version.version,
      preparedVersion.sha256,
      preparedVersion.bytes,
      preparedVersion.path,
      IMPORT_ACTOR,
      workId,
      now,
    );
    insertedVersions += 1;
  }
  if (!insertedEntry) {
    const currentExists = db
      .query<{ present: number }, [number | bigint, number]>(
        "SELECT 1 AS present FROM knowledge_versions WHERE entry_id = ? AND version = ?",
      )
      .get(entryId, record.currentVersion);
    if (currentExists !== null) {
      db.query("UPDATE knowledge_entries SET current_version = ? WHERE id = ?").run(
        record.currentVersion,
        entryId,
      );
    }
  }
  return { entryId, insertedEntry, insertedVersions, versionConflicts };
}

export function applyPackage(
  contents: PackageContents,
  db: Database,
  options: ApplyOptions,
): ApplyResult {
  const projectId = options.projectId;
  const now = options.now().toISOString();
  const warnings = options.warnings;
  const inserted: ImportCounts = {
    work: 0,
    events: 0,
    evidence: 0,
    signals: 0,
    knowledge: 0,
    knowledgeVersions: 0,
    mapping: 0,
    raw: 0,
  };
  const skipped: ImportCounts = {
    work: 0,
    events: 0,
    evidence: 0,
    signals: 0,
    knowledge: 0,
    knowledgeVersions: 0,
    mapping: 0,
    raw: 0,
  };

  const index = mappingIndex(contents);
  const rawHashes = prepareRaw(contents, options.home, warnings);
  const knowledgePrepared = prepareKnowledge(contents, options.home, projectId, warnings);

  withImmediateTransaction(db, () => {
    ensureProject(db, contents, now);
    const rawMappings = insertRawMappings(contents, db, projectId, rawHashes, now, warnings);
    inserted.raw += rawMappings;
    inserted.mapping += rawMappings;

    // 工作與依賴
    const workIdMap = new Map<string, string>();
    const insertedWorks = new Set<string>();
    const usedWorkIds = new Set<string>();
    for (const record of contents.work) {
      const info = mappingInfo(index, "work", record.workId);
      const key = sourceKey(projectId, info.sourceId);
      const existing = findMapping(db, "work", info.layer, key);
      if (existing !== null && workExists(db, existing.target_id)) {
        skipped.work += 1;
        workIdMap.set(record.workId, existing.target_id);
        continue;
      }
      const target =
        existing?.target_id ??
        allocateId(
          db,
          "work_items",
          "work_id",
          record.workId,
          projectId,
          "work",
          info.sourceId,
          usedWorkIds,
        );
      if (existing !== null) usedWorkIds.add(target);
      insertWork(db, projectId, target, record, now);
      insertMapping(db, {
        entity: "work",
        layer: info.layer,
        sourceId: key,
        sourceRoot: projectId,
        sourceRecord: info.sourceRecord,
        targetId: target,
        sourceRef: info.sourceRef,
        sha256: null,
        note: info.note,
        importedAt: now,
      });
      inserted.work += 1;
      inserted.mapping += 1;
      insertedWorks.add(target);
      workIdMap.set(record.workId, target);
    }

    for (const record of contents.work) {
      const target = workIdMap.get(record.workId);
      if (target === undefined || !insertedWorks.has(target)) continue;
      if (record.planId !== undefined) {
        const planTarget = workIdMap.get(record.planId);
        if (planTarget === undefined) {
          warnings.add(`MISSING_WORK_REFERENCE ${record.workId} -> ${record.planId}`);
        } else if (planTarget !== target) {
          db.query("UPDATE work_items SET plan_id = ? WHERE work_id = ?").run(planTarget, target);
        }
      }
      for (const dependency of record.dependsOn ?? []) {
        const dependencyTarget = workIdMap.get(dependency);
        if (dependencyTarget === undefined) {
          warnings.add(`MISSING_WORK_REFERENCE ${record.workId} -> ${dependency}`);
          continue;
        }
        if (dependencyTarget === target) continue;
        db.query(
          `INSERT OR IGNORE INTO work_dependencies (work_id, depends_on_work_id, created_at)
           VALUES (?, ?, ?)`,
        ).run(target, dependencyTarget, now);
      }
    }

    // 事件
    const baseRow = db
      .query<{ sequence: number | null }, [string]>(
        "SELECT MAX(sequence) AS sequence FROM events WHERE project_id = ?",
      )
      .get(projectId);
    const base = baseRow?.sequence ?? 0;
    const usedSequences = new Set<number>();
    for (const row of db
      .query<{ sequence: number }, [string]>("SELECT sequence FROM events WHERE project_id = ?")
      .all(projectId)) {
      usedSequences.add(row.sequence);
    }
    let nextSequence = base + 1;
    const usedEventIds = new Set<string>();
    const sortedEvents = [...contents.events].sort(
      (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
    );
    for (const record of sortedEvents) {
      const info = mappingInfo(index, "event", record.eventId);
      const key = sourceKey(projectId, info.sourceId);
      const existing = findMapping(db, "event", info.layer, key);
      const existingRow =
        existing === null
          ? null
          : db
              .query<{ present: number }, [string]>("SELECT 1 AS present FROM events WHERE event_id = ?")
              .get(existing.target_id);
      if (existing !== null && existingRow !== null) {
        skipped.events += 1;
        continue;
      }
      const target =
        existing?.target_id ??
        allocateId(
          db,
          "events",
          "event_id",
          record.eventId,
          projectId,
          "event",
          info.sourceId,
          usedEventIds,
        );
      if (existing !== null) usedEventIds.add(target);
      let sequence = record.sequence;
      if (usedSequences.has(sequence)) {
        while (usedSequences.has(nextSequence)) nextSequence += 1;
        sequence = nextSequence;
        nextSequence += 1;
      }
      usedSequences.add(sequence);
      const workId = record.workId === undefined ? null : workIdMap.get(record.workId) ?? null;
      if (record.workId !== undefined && workId === null) {
        warnings.add(`MISSING_WORK_REFERENCE ${record.eventId} -> ${record.workId}`);
      }
      insertEvent(db, projectId, target, sequence, record, workId, now);
      insertMapping(db, {
        entity: "event",
        layer: info.layer,
        sourceId: key,
        sourceRoot: projectId,
        sourceRecord: info.sourceRecord,
        targetId: target,
        sourceRef: info.sourceRef,
        sha256: null,
        note: info.note,
        importedAt: now,
      });
      inserted.events += 1;
      inserted.mapping += 1;
    }

    // 證據
    const safeEvidencePaths = new Set<string>();
    for (const file of contents.raw) {
      safeEvidencePaths.add(`raw/${file.layer}/${file.path}`);
    }
    for (const entry of contents.knowledge) {
      for (const version of entry.record.versions) {
        safeEvidencePaths.add(version.path);
      }
    }
    const usedEvidenceIds = new Set<string>();
    for (const record of contents.evidence) {
      const info = mappingInfo(index, "evidence", record.evidenceId);
      const key = sourceKey(projectId, info.sourceId);
      const existing = findMapping(db, "evidence", info.layer, key);
      if (
        existing !== null &&
        db
          .query<{ present: number }, [string]>("SELECT 1 AS present FROM evidence WHERE evidence_id = ?")
          .get(existing.target_id) !== null
      ) {
        skipped.evidence += 1;
        continue;
      }
      const workId = workIdMap.get(record.workId);
      if (workId === undefined) {
        warnings.add(`MISSING_WORK_REFERENCE ${record.evidenceId} -> ${record.workId}`);
        continue;
      }
      if (record.path !== undefined) {
        if (!safeEvidencePaths.has(record.path)) {
          warnings.add(`EVIDENCE_PATH_UNSAFE ${record.evidenceId}：${record.path}`);
          continue;
        }
        if (record.sha256 !== undefined) {
          const absolute = join(contents.root, record.path);
          let actual = "";
          try {
            actual = sha256Bytes(readFileSync(absolute));
          } catch {
            warnings.add(`EVIDENCE_PATH_UNREADABLE ${record.evidenceId}：${record.path}`);
            continue;
          }
          if (actual !== record.sha256) {
            warnings.add(`EVIDENCE_HASH_MISMATCH ${record.evidenceId}：${record.path}`);
          }
        }
      }
      const target =
        existing?.target_id ??
        allocateId(
          db,
          "evidence",
          "evidence_id",
          record.evidenceId,
          projectId,
          "evidence",
          info.sourceId,
          usedEvidenceIds,
        );
      if (existing !== null) usedEvidenceIds.add(target);
      insertEvidence(db, projectId, target, record, workId, now);
      insertMapping(db, {
        entity: "evidence",
        layer: info.layer,
        sourceId: key,
        sourceRoot: projectId,
        sourceRecord: info.sourceRecord,
        targetId: target,
        sourceRef: info.sourceRef,
        sha256: null,
        note: info.note,
        importedAt: now,
      });
      inserted.evidence += 1;
      inserted.mapping += 1;
    }

    // 訊號
    const usedSignalIds = new Set<string>();
    for (const record of contents.signals) {
      const info = mappingInfo(index, "signal", record.signalId);
      const key = sourceKey(projectId, info.sourceId);
      const existing = findMapping(db, "signal", info.layer, key);
      if (
        existing !== null &&
        db
          .query<{ present: number }, [string]>("SELECT 1 AS present FROM signals WHERE signal_id = ?")
          .get(existing.target_id) !== null
      ) {
        skipped.signals += 1;
        continue;
      }
      const target =
        existing?.target_id ??
        allocateId(
          db,
          "signals",
          "signal_id",
          record.signalId,
          projectId,
          "signal",
          info.sourceId,
          usedSignalIds,
        );
      if (existing !== null) usedSignalIds.add(target);
      const workId = record.workId === undefined ? null : workIdMap.get(record.workId) ?? null;
      if (record.workId !== undefined && workId === null) {
        warnings.add(`MISSING_WORK_REFERENCE ${record.signalId} -> ${record.workId}`);
      }
      if (Array.from(record.message).length > 1000) {
        warnings.add(`SIGNAL_MESSAGE_TRUNCATED ${record.signalId}`);
      }
      insertSignal(db, projectId, target, record, workId, info.layer, now);
      insertMapping(db, {
        entity: "signal",
        layer: info.layer,
        sourceId: key,
        sourceRoot: projectId,
        sourceRecord: info.sourceRecord,
        targetId: target,
        sourceRef: info.sourceRef,
        sha256: null,
        note: info.note,
        importedAt: now,
      });
      inserted.signals += 1;
      inserted.mapping += 1;
    }

    // 知識與版本
    for (const entry of contents.knowledge) {
      const record = entry.record;
      const info = mappingInfo(index, "knowledge", record.knowledgeId, record.layer);
      const key = sourceKey(projectId, info.sourceId);
      const existing = findMapping(db, "knowledge", info.layer, key);
      const targetKnowledgeId = existing?.target_id ?? record.knowledgeId;
      const workId = record.workId === undefined ? null : workIdMap.get(record.workId) ?? null;
      if (record.workId !== undefined && workId === null) {
        warnings.add(`MISSING_WORK_REFERENCE ${record.knowledgeId} -> ${record.workId}`);
      }
      const result = insertKnowledge(
        db,
        projectId,
        targetKnowledgeId,
        entry,
        knowledgePrepared,
        workId,
        now,
      );
      if (result.insertedEntry) {
        inserted.knowledge += 1;
      } else {
        skipped.knowledge += 1;
      }
      inserted.knowledgeVersions += result.insertedVersions;
      for (const conflict of result.versionConflicts) {
        warnings.add(`KNOWLEDGE_VERSION_CONFLICT ${record.knowledgeId} v${conflict}`);
      }
      if (result.insertedVersions === 0) {
        skipped.knowledgeVersions += entry.versions.length;
      } else {
        skipped.knowledgeVersions += entry.versions.length - result.insertedVersions;
      }
      if (
        insertMapping(db, {
          entity: "knowledge",
          layer: info.layer,
          sourceId: key,
          sourceRoot: projectId,
          sourceRecord: info.sourceRecord,
          targetId: targetKnowledgeId,
          sourceRef: info.sourceRef,
          sha256: null,
          note: info.note,
          importedAt: now,
        })
      ) {
        inserted.mapping += 1;
      }
    }
  });

  skipped.raw = Math.max(0, contents.raw.length - inserted.raw);
  skipped.mapping = Math.max(0, contents.mapping.length - inserted.mapping);
  return { inserted, skipped };
}

export { knowledgeKind };
