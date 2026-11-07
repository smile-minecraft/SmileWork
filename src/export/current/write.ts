import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, canonicalJsonPretty, compareCodePoints, uniqueSorted } from "../../export/v3/canonical.ts";
import type { CurrentPackage } from "./types.ts";
import { ExportCurrentError } from "./errors.ts";

function writeJsonLines(path: string, records: readonly unknown[]): void {
  const body = records.map((record) => canonicalJson(record)).join("\n");
  writeFileSync(path, records.length === 0 ? "" : `${body}\n`, "utf8");
}

function sortedWork(records: CurrentPackage["work"]): CurrentPackage["work"] {
  return [...records]
    .sort((left, right) => compareCodePoints(left.workId, right.workId))
    .map((record) => {
      const next = { ...record };
      for (const key of ["dependsOn", "nonGoals", "contextRefs", "scopePaths"] as const) {
        const value = next[key];
        if (value !== undefined) next[key] = uniqueSorted(value);
      }
      return next;
    });
}

function sortedEvents(records: CurrentPackage["events"]): CurrentPackage["events"] {
  return [...records].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return compareCodePoints(left.eventId, right.eventId);
  });
}

function sortedEvidence(records: CurrentPackage["evidence"]): CurrentPackage["evidence"] {
  return [...records].sort((left, right) => compareCodePoints(left.evidenceId, right.evidenceId));
}

function sortedSignals(records: CurrentPackage["signals"]): CurrentPackage["signals"] {
  return [...records].sort((left, right) => compareCodePoints(left.signalId, right.signalId));
}

function sortedKnowledge(records: CurrentPackage["knowledge"]): CurrentPackage["knowledge"] {
  return [...records].sort((left, right) =>
    compareCodePoints(left.record.knowledgeId, right.record.knowledgeId),
  );
}

function sortedMapping(records: CurrentPackage["mapping"]): CurrentPackage["mapping"] {
  return [...records].sort((left, right) => {
    const entity = compareCodePoints(left.entity, right.entity);
    if (entity !== 0) return entity;
    const layer = compareCodePoints(left.layer, right.layer);
    if (layer !== 0) return layer;
    const source = compareCodePoints(left.sourceId, right.sourceId);
    if (source !== 0) return source;
    return compareCodePoints(left.targetId, right.targetId);
  });
}

function sortedRaw(records: CurrentPackage["raw"]): CurrentPackage["raw"] {
  return [...records].sort((left, right) => {
    const layer = compareCodePoints(left.layer, right.layer);
    return layer !== 0 ? layer : compareCodePoints(left.path, right.path);
  });
}

function assertSafeRelative(path: string, label: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ExportCurrentError("UNSAFE_PATH", `${label} 不是安全相對路徑：${path}`);
  }
}

function writeContents(root: string, pkg: CurrentPackage): void {
  mkdirSync(join(root, "knowledge", "files"), { recursive: true });
  mkdirSync(join(root, "raw", "project"), { recursive: true });
  mkdirSync(join(root, "raw", "global"), { recursive: true });

  const work = sortedWork(pkg.work);
  const events = sortedEvents(pkg.events);
  const evidence = sortedEvidence(pkg.evidence);
  const signals = sortedSignals(pkg.signals);
  const knowledge = sortedKnowledge(pkg.knowledge);
  const mapping = sortedMapping(pkg.mapping);
  const raw = sortedRaw(pkg.raw);

  writeJsonLines(join(root, "work.jsonl"), work);
  writeJsonLines(join(root, "events.jsonl"), events);
  writeJsonLines(join(root, "evidence.jsonl"), evidence);
  writeJsonLines(join(root, "signals.jsonl"), signals);
  writeJsonLines(
    join(root, "knowledge", "index.jsonl"),
    knowledge.map((entry) => entry.record),
  );
  writeJsonLines(join(root, "mapping.jsonl"), mapping);

  for (const entry of knowledge) {
    const versions = new Map(entry.versions.map((version) => [version.version, version.body]));
    for (const version of entry.record.versions) {
      const body = versions.get(version.version);
      if (body === undefined) {
        throw new ExportCurrentError(
          "KNOWLEDGE_BODY_MISSING",
          `知識版本沒有內容：${entry.record.knowledgeId} v${version.version}`,
        );
      }
      assertSafeRelative(version.path, "知識版本路徑");
      const target = join(root, version.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, "utf8");
    }
  }

  for (const file of raw) {
    assertSafeRelative(file.path, "raw 檔案路徑");
    const target = join(root, "raw", file.layer, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }

  writeFileSync(join(root, "manifest.json"), canonicalJsonPretty(pkg.manifest), "utf8");
}

function hasEntries(path: string): boolean {
  return readdirSync(path).length > 0;
}

/** 先寫到旁邊的暫存資料夾，完成後才換上去。 */
export function writeCurrentPackage(
  outDir: string,
  pkg: CurrentPackage,
  options: { force: boolean },
): string {
  const out = resolve(outDir);
  if (existsSync(out)) {
    let stats;
    try {
      stats = statSync(out);
    } catch (error) {
      throw new ExportCurrentError("OUTPUT_UNREADABLE", `無法讀取輸出位置：${out}`, [String(error)]);
    }
    if (!stats.isDirectory()) {
      throw new ExportCurrentError("OUTPUT_NOT_A_DIRECTORY", `輸出位置不是資料夾：${out}`);
    }
    if (!options.force && hasEntries(out)) {
      throw new ExportCurrentError(
        "OUTPUT_NOT_EMPTY",
        `輸出資料夾不是空的：${out}。要用新匯出取代時請加上 --force。`,
      );
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  const temporary = mkdtempSync(join(dirname(out), `.${basename(out)}.tmp-`));
  let backup: string | undefined;
  try {
    writeContents(temporary, pkg);
    if (existsSync(out)) {
      backup = `${out}.old-${process.pid}-${Date.now()}`;
      renameSync(out, backup);
    }
    renameSync(temporary, out);
    if (backup !== undefined) rmSync(backup, { recursive: true, force: true });
    return out;
  } catch (error) {
    if (backup !== undefined && !existsSync(out)) {
      try {
        renameSync(backup, out);
      } catch {
        // 還原失敗時保留 backup，讓使用者可以手動取回。
      }
    }
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
