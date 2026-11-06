import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { readFileSync } from "node:fs";

import type { RecordPart } from "./types";

const SCHEMA_URL = new URL(
  "../../../schemas/export-v1/export-v1.schema.json",
  import.meta.url,
);
const SCHEMA_ID = "urn:smilework:export:v1";

const DEFINITION_BY_PART: Record<RecordPart, string> = {
  work: "workRecord",
  events: "eventRecord",
  evidence: "evidenceRecord",
  signals: "signalRecord",
  knowledge: "knowledgeRecord",
  mapping: "mappingRecord",
};

let cachedSchema: Record<string, unknown> | undefined;
let cachedManifestValidator: ValidateFunction | undefined;
let cachedRecordValidators: Record<RecordPart, ValidateFunction> | undefined;

export function readSchemaDocument(): Record<string, unknown> {
  if (cachedSchema !== undefined) return cachedSchema;
  cachedSchema = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as Record<string, unknown>;
  return cachedSchema;
}

function createValidator(): {
  manifest: ValidateFunction;
  records: Record<RecordPart, ValidateFunction>;
} {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = readSchemaDocument();
  ajv.addSchema(schema, SCHEMA_ID);

  const manifest = ajv.getSchema(SCHEMA_ID);
  if (manifest === undefined) {
    throw new Error("找不到匯出格式的 manifest schema");
  }

  const records = {} as Record<RecordPart, ValidateFunction>;
  for (const [part, definition] of Object.entries(DEFINITION_BY_PART) as Array<
    [RecordPart, string]
  >) {
    const validator = ajv.getSchema(`${SCHEMA_ID}#/$defs/${definition}`);
    if (validator === undefined) {
      throw new Error(`找不到匯出格式的 schema 定義：${definition}`);
    }
    records[part] = validator;
  }

  return { manifest, records };
}

function validators(): {
  manifest: ValidateFunction;
  records: Record<RecordPart, ValidateFunction>;
} {
  if (cachedManifestValidator !== undefined && cachedRecordValidators !== undefined) {
    return { manifest: cachedManifestValidator, records: cachedRecordValidators };
  }
  const created = createValidator();
  cachedManifestValidator = created.manifest;
  cachedRecordValidators = created.records;
  return created;
}

export function formatSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath === "" ? "/" : error.instancePath;
    return `${location}：${error.message ?? "不符合 schema"}`;
  });
}

export function validateManifestSchema(value: unknown): string[] {
  const validator = validators().manifest;
  if (validator(value)) return [];
  return formatSchemaErrors(validator.errors);
}

export function validateRecordSchema(part: RecordPart, value: unknown): string[] {
  const validator = validators().records[part];
  if (validator(value)) return [];
  return formatSchemaErrors(validator.errors);
}
