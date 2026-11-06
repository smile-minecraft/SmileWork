import { describe, expect, test } from "bun:test";

import { mapLegacyStatus } from "../../src/export/v3/status.ts";
import type { Resolution, WorkStatus } from "../../src/export/v3/types.ts";

describe("舊狀態對應", () => {
  const cases: Array<[string, WorkStatus, Resolution | undefined]> = [
    ["NEW", "open", undefined],
    ["DRAFT", "open", undefined],
    ["CLARIFYING", "open", undefined],
    ["PLANNED", "open", undefined],
    ["IN_PROGRESS", "in_progress", undefined],
    ["ACTIVE", "in_progress", undefined],
    ["BLOCKED", "blocked", undefined],
    ["REVIEWING", "review", undefined],
    ["ARCHIVING", "review", undefined],
    ["COMPLETED", "done", "completed"],
    ["DONE", "done", "completed"],
    ["FAILED", "done", "failed"],
    ["CANCELLED", "cancelled", "abandoned"],
  ];

  test.each(cases)("%s 轉成 %s", (legacy, status, resolution) => {
    expect(mapLegacyStatus(legacy)).toEqual({ status, resolution });
  });

  test("表中沒有的狀態回 undefined，不猜測", () => {
    expect(mapLegacyStatus("SOMEDAY")).toBeUndefined();
    expect(mapLegacyStatus("")).toBeUndefined();
  });

  test("前後空白與大小寫不影響對應", () => {
    expect(mapLegacyStatus("  in_progress ")).toEqual({ status: "in_progress" });
    expect(mapLegacyStatus("completed")).toEqual({ status: "done", resolution: "completed" });
  });
});
