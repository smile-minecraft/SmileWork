import { describe, expect, test } from "bun:test";
import { expectOk, withWorkTools } from "./helpers.ts";

describe("work_get 的派工說明", () => {
  test("brief 由欄位產生，包含目標、範圍、驗收與依賴", async () => {
    await withWorkTools(async (context) => {
      const prerequisite = expectOk(
        await context.call("work_create", {
          kind: "plan",
          title: "先完成資料庫",
          objective: "建立 schema。",
        }),
      ).data.work;

      const task = expectOk(
        await context.call("work_create", {
          kind: "task",
          title: "實作工作工具",
          objective: "讓代理可以建立與查詢工作。",
          nonGoals: ["不做結案流程"],
          contextRefs: ["docs/export-format-v1.md"],
          scopePaths: ["src/work", "tests/work"],
          acceptance: ["建立成功", "查詢成功"],
          dependsOn: [prerequisite.id],
          owner: "build",
          risk: "medium",
        }),
      ).data.work;

      const result = expectOk(await context.call("work_get", { id: task.id, format: "brief" }));
      const brief = result.data.brief as string;

      expect(typeof brief).toBe("string");
      expect(brief).toContain("實作工作工具");
      expect(brief).toContain("讓代理可以建立與查詢工作。");
      expect(brief).toContain("不做結案流程");
      expect(brief).toContain("src/work");
      expect(brief).toContain("tests/work");
      expect(brief).toContain("建立成功");
      expect(brief).toContain("查詢成功");
      expect(brief).toContain(prerequisite.id);
      expect(result.data).toMatchObject({ id: task.id, version: 1 });
      expect(result.data.work).toBeUndefined();
    });
  });

  test("full 格式回完整工作與證據，不回 brief", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "讀取格式", objective: "確認 full 格式。" }),
      ).data.work;

      const result = expectOk(await context.call("work_get", { id: work.id }));
      expect(result.data.work.id).toBe(work.id);
      expect(result.data.brief).toBeUndefined();
      expect(Array.isArray(result.data.evidence)).toBe(true);
    });
  });
});
