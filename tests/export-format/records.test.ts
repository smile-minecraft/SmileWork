import { describe, expect, test } from "bun:test";

import { examplePackageInput } from "./helpers/fixture";
import { validateRecordSchema } from "./helpers/schemas";
import type {
  EventRecord,
  EvidenceRecord,
  KnowledgeRecord,
  MappingRecord,
  SignalRecord,
  WorkRecord,
} from "./helpers/types";

const input = examplePackageInput();
const doneWork = input.work.find((record) => record.workId === "w-task-format")!;
const openWork: WorkRecord = {
  workId: "w-open",
  kind: "task",
  title: "待處理工作",
  status: "open",
  owner: "build",
  priority: "low",
};
const statusEvent = input.events.find((record) => record.kind === "status_changed")!;
const testEvidence = input.evidence[0]!;
const warningSignal = input.signals[0]!;
const knowledge: KnowledgeRecord = {
  knowledgeId: "k-test",
  type: "decision",
  layer: "project",
  title: "測試知識",
  description: "",
  pinned: false,
  source: "manual",
  versions: [
    {
      version: 1,
      path: "knowledge/files/k-test/v1.md",
      sha256: "0".repeat(64),
      bytes: 10,
    },
  ],
  currentVersion: 1,
};
const mapping = input.mapping[0]!;

describe("work.jsonl 狀態與 resolution", () => {
  test("六個合法狀態都通過", () => {
    const statuses = ["open", "in_progress", "blocked", "review", "done", "cancelled"] as const;
    for (const status of statuses) {
      const record: WorkRecord = { ...openWork, status };
      if (status === "done") record.resolution = "completed";
      if (status === "cancelled") record.resolution = "abandoned";

      expect(validateRecordSchema("work", record)).toEqual([]);
    }
  });

  test("不合法的狀態值會被拒絕", () => {
    const errors = validateRecordSchema("work", { ...openWork, status: "archived" });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("status");
  });

  test("done 必須有 resolution", () => {
    const record = { ...doneWork };
    delete (record as Partial<WorkRecord>).resolution;

    const errors = validateRecordSchema("work", record);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("resolution");
  });

  test("open 不可以有 resolution", () => {
    const errors = validateRecordSchema("work", { ...openWork, resolution: "completed" });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("resolution");
  });

  test("cancelled 的 resolution 只能是 abandoned", () => {
    const errors = validateRecordSchema("work", {
      ...openWork,
      status: "cancelled",
      resolution: "completed",
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("resolution");
  });

  test("不合法的 resolution 會被拒絕", () => {
    const errors = validateRecordSchema("work", {
      ...doneWork,
      resolution: "rejected",
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("resolution");
  });
});

describe("其他紀錄的列舉與必填欄位", () => {
  test("work 的額外欄位會被拒絕", () => {
    const errors = validateRecordSchema("work", { ...openWork, createdAt: "2026-01-01T00:00:00.000Z" });

    expect(errors.length).toBeGreaterThan(0);
  });

  test("event 的 status_changed 必須有 toStatus", () => {
    const record: EventRecord = { ...statusEvent };
    delete record.toStatus;

    const errors = validateRecordSchema("events", record);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("toStatus");
  });

  test("event 的狀態值也受限制", () => {
    const errors = validateRecordSchema("events", { ...statusEvent, toStatus: "archived" });

    expect(errors.length).toBeGreaterThan(0);
  });

  test("evidence 的 link 必須有 url", () => {
    const record: EvidenceRecord = { ...testEvidence, kind: "link" };
    delete record.command;
    delete record.output;

    const errors = validateRecordSchema("evidence", record);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("url");
  });

  test("signal 的 severity 只能是 info、warning、error", () => {
    const record: SignalRecord = { ...warningSignal, severity: "critical" as never };

    const errors = validateRecordSchema("signals", record);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("severity");
  });

  test("knowledge 的版本必須有 sha256 與 bytes", () => {
    const record: KnowledgeRecord = {
      ...knowledge,
      versions: knowledge.versions.map((version) => ({
        version: version.version,
        path: version.path,
      })) as never,
    };

    const errors = validateRecordSchema("knowledge", record);

    expect(errors.length).toBeGreaterThan(0);
  });

  test("mapping 的 entity 只能是六種實體", () => {
    const record: MappingRecord = { ...mapping, entity: "project" as never };

    const errors = validateRecordSchema("mapping", record);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("entity");
  });
});
