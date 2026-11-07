import { describe, expect, test } from "bun:test";
import { expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("work_create 與 work_get", () => {
  test("建立 plan 與 task，work_get 回完整欄位", async () => {
    await withWorkTools(async (context) => {
      const planResult = await context.call("work_create", {
        kind: "plan",
        title: "交付共用工作伺服器",
        objective: "讓多個代理共用同一份工作狀態。",
        nonGoals: ["不做圖形介面"],
        contextRefs: ["docs/export-format-v1.md"],
        scopePaths: ["src/work", "tests/work"],
        acceptance: ["工具可用", "資料可查"],
        priority: "high",
        risk: "low",
        labels: ["infra", "mcp"],
        owner: "arch",
      });
      const plan = expectOk(planResult);
      expect(Object.keys(plan).sort()).toEqual(["data", "ok", "summary"]);

      const planWork = plan.data.work;
      expect(planWork).toMatchObject({
        kind: "plan",
        parentId: null,
        title: "交付共用工作伺服器",
        objective: "讓多個代理共用同一份工作狀態。",
        nonGoals: ["不做圖形介面"],
        contextRefs: ["docs/export-format-v1.md"],
        scopePaths: ["src/work", "tests/work"],
        acceptance: ["工具可用", "資料可查"],
        status: "open",
        resolution: null,
        risk: "low",
        priority: "high",
        labels: ["infra", "mcp"],
        owner: "arch",
        dependsOn: [],
        review: null,
        acceptanceResults: null,
        version: 1,
      });
      expect(typeof planWork.id).toBe("string");
      expect(planWork.id.length).toBeGreaterThan(0);
      expect(typeof planWork.projectId).toBe("string");
      expect(typeof planWork.createdAt).toBe("string");
      expect(typeof planWork.updatedAt).toBe("string");
      expect(Object.keys(planWork).sort()).toEqual(
        [
          "acceptance",
          "acceptanceResults",
          "contextRefs",
          "createdAt",
          "dependsOn",
          "id",
          "kind",
          "labels",
          "nonGoals",
          "objective",
          "owner",
          "parentId",
          "priority",
          "projectId",
          "resolution",
          "review",
          "risk",
          "scopePaths",
          "status",
          "title",
          "updatedAt",
          "version",
        ].sort(),
      );

      const taskResult = await context.call("work_create", {
        kind: "task",
        title: "實作工作建立與查詢",
        parentId: planWork.id,
        objective: "五個工具都能用。",
        acceptance: ["建立成功", "查詢成功"],
        dependsOn: [],
        labels: ["crud"],
      });
      const task = expectOk(taskResult).data.work;
      expect(task).toMatchObject({ kind: "task", parentId: planWork.id, status: "open", version: 1 });

      const gotPlan = expectOk(await context.call("work_get", { id: planWork.id }));
      expect(gotPlan.data.work).toMatchObject(planWork);
      expect(gotPlan.data.work.projectId).toBe(planWork.projectId);

      const gotTask = expectOk(await context.call("work_get", { id: task.id }));
      expect(gotTask.data.work).toMatchObject({
        id: task.id,
        kind: "task",
        parentId: planWork.id,
        title: "實作工作建立與查詢",
        objective: "五個工具都能用。",
        acceptance: ["建立成功", "查詢成功"],
        labels: ["crud"],
        status: "open",
        version: 1,
      });
      expect(gotTask.data.evidence).toEqual([]);
    });
  });

  test("建立時依賴不存在回 WORK_NOT_FOUND", async () => {
    await withWorkTools(async (context) => {
      const result = expectFail(
        await context.call("work_create", {
          title: "孤兒工作",
          dependsOn: ["work-does-not-exist"],
        }),
      );
      expect(result.code).toBe("WORK_NOT_FOUND");
      expect(result.data).toMatchObject({ id: "work-does-not-exist" });
    });
  });

  test("缺必填欄位回 VALIDATION_ERROR 與固定失敗外框", async () => {
    await withWorkTools(async (context) => {
      const result = expectFail(await context.call("work_create", { title: "" }));
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(result).sort()).toEqual(["code", "data", "message", "nextAction", "ok"]);
      expect(Array.isArray(result.data.issues)).toBe(true);
    });
  });

  test("讀取不存在的工作回 WORK_NOT_FOUND", async () => {
    await withWorkTools(async (context) => {
      const result = expectFail(await context.call("work_get", { id: "work-missing" }));
      expect(result.code).toBe("WORK_NOT_FOUND");
      expect(result.data).toMatchObject({ id: "work-missing" });
    });
  });
});
