import { describe, expect, test } from "bun:test";
import { expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("work_update", () => {
  test("expectedVersion 正確時更新，版本不符回 VERSION_CONFLICT 並附目前內容", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "原始標題", objective: "原始目標。" }),
      ).data.work;

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          title: "新標題",
          objective: "新目標。",
          labels: ["renamed"],
        }),
      );
      expect(updated.data.work).toMatchObject({
        id: work.id,
        title: "新標題",
        objective: "新目標。",
        labels: ["renamed"],
        version: 2,
      });

      const byLabel = expectOk(await context.call("work_list", { label: "renamed" }));
      expect(byLabel.data.items.map((item: { id: string }) => item.id)).toEqual([work.id]);

      const conflict = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          title: "過期更新",
        }),
      );
      expect(conflict.code).toBe("VERSION_CONFLICT");
      expect(conflict.data.currentVersion).toBe(2);
      expect(conflict.data.work).toMatchObject({
        id: work.id,
        title: "新標題",
        version: 2,
      });

      const reread = expectOk(await context.call("work_get", { id: work.id }));
      expect(reread.data.work).toMatchObject({ title: "新標題", version: 2 });
    });
  });

  test("狀態轉移照狀態機，review 與 done 由其他工具負責", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "狀態測試" })).data.work;

      const blocked = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          status: "blocked",
        }),
      );
      expect(blocked.data.work).toMatchObject({ status: "blocked", version: 2 });

      const inProgress = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 2,
          status: "in_progress",
        }),
      );
      expect(inProgress.data.work).toMatchObject({ status: "in_progress", version: 3 });

      for (const target of ["review", "done"]) {
        const rejected = expectFail(
          await context.call("work_update", {
            id: work.id,
            expectedVersion: 3,
            status: target,
          }),
        );
        expect(rejected.code).toBe("INVALID_TRANSITION");
        expect(rejected.data).toMatchObject({ from: "in_progress", to: target });
        expect(rejected.nextAction).toContain("work_review");
        if (target === "done") expect(rejected.nextAction).toContain("work_complete");
      }

      const cancelled = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 3,
          status: "cancelled",
        }),
      );
      expect(cancelled.data.work).toMatchObject({
        status: "cancelled",
        resolution: "abandoned",
        version: 4,
      });

      const reopen = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 4,
          status: "in_progress",
        }),
      );
      expect(reopen.code).toBe("INVALID_TRANSITION");
    });
  });

  test("不存在的 id 回 WORK_NOT_FOUND，缺 expectedVersion 回 VALIDATION_ERROR", async () => {
    await withWorkTools(async (context) => {
      const missing = expectFail(
        await context.call("work_update", { id: "work-missing", expectedVersion: 1 }),
      );
      expect(missing.code).toBe("WORK_NOT_FOUND");

      const work = expectOk(await context.call("work_create", { title: "必填版本" })).data.work;
      const invalid = expectFail(await context.call("work_update", { id: work.id }));
      expect(invalid.code).toBe("VALIDATION_ERROR");
    });
  });

  test("更新依賴會反映在 work_get 與 work_ready", async () => {
    await withWorkTools(async (context) => {
      const dependency = expectOk(await context.call("work_create", { title: "依賴項" })).data.work;
      const work = expectOk(
        await context.call("work_create", { title: "等待項", dependsOn: [dependency.id] }),
      ).data.work;

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          removeDependsOn: [dependency.id],
        }),
      );
      expect(updated.data.work.dependsOn).toEqual([]);

      const added = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 2,
          addDependsOn: [dependency.id],
        }),
      );
      expect(added.data.work.dependsOn).toEqual([dependency.id]);
    });
  });
});
