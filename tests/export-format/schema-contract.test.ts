import { describe, expect, test } from "bun:test";

import { readSchemaDocument } from "./helpers/schemas";
import { RESOLUTIONS, WORK_STATUSES } from "./helpers/types";

interface SchemaShape {
  $schema: string;
  $id: string;
  $defs: Record<string, Record<string, unknown>>;
}

describe("JSON Schema 契約", () => {
  const schema = readSchemaDocument() as unknown as SchemaShape;
  const manifest = schema.$defs.manifest!;
  const properties = manifest.properties as Record<string, Record<string, unknown>>;

  test("使用 JSON Schema draft 2020-12", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("urn:smilework:export:v1");
  });

  test("formatVersion 固定為整數 1", () => {
    expect(properties.formatVersion?.const).toBe(1);
    expect(properties.format?.const).toBe("smilework-export");
  });

  test("狀態列舉固定", () => {
    const status = schema.$defs.status!;
    expect(status.enum).toEqual([...WORK_STATUSES]);
  });

  test("resolution 列舉固定", () => {
    const resolution = schema.$defs.resolution!;
    expect(resolution.enum).toEqual([...RESOLUTIONS]);
  });

  test("manifest 與紀錄都拒絕未知欄位", () => {
    expect(manifest.additionalProperties).toBe(false);
    for (const name of [
      "workRecord",
      "eventRecord",
      "evidenceRecord",
      "signalRecord",
      "knowledgeRecord",
      "mappingRecord",
    ]) {
      expect(schema.$defs[name]?.additionalProperties).toBe(false);
    }
  });

  test("來源分層與 raw 計數欄位在 schema 內", () => {
    expect(schema.$defs.source?.required).toContain("layers");
    expect(schema.$defs.layoutRaw?.required).toEqual([
      "path",
      "files",
      "projectFiles",
      "globalFiles",
    ]);
  });

  test("work 的規劃、風險與驗收欄位在 schema 內", () => {
    const properties = schema.$defs.workRecord?.properties as Record<string, unknown>;
    for (const name of [
      "objective",
      "nonGoals",
      "contextRefs",
      "scopePaths",
      "acceptance",
      "risk",
      "review",
      "acceptanceResults",
    ]) {
      expect(properties[name]).toBeDefined();
    }
  });

  test("mapping 要求分層與來源定位欄位", () => {
    expect(schema.$defs.mappingRecord?.required).toEqual([
      "entity",
      "layer",
      "sourceRoot",
      "sourceId",
      "targetId",
      "sourceRef",
    ]);
    expect(schema.$defs.sourceRecord).toBeDefined();
  });

  test("manifest 的八個部分都是必填", () => {
    expect(manifest.required).toEqual([
      "format",
      "formatVersion",
      "createdAt",
      "producer",
      "source",
      "layout",
      "warnings",
    ]);
    const layout = schema.$defs.manifestLayout!;
    expect(layout.required).toEqual([
      "manifest",
      "work",
      "events",
      "evidence",
      "signals",
      "knowledge",
      "mapping",
      "raw",
    ]);
  });
});
