import { describe, expect, test } from "bun:test";
import { expectOk, markWorkDone, withWorkTools } from "./helpers.ts";

describe("work_ready", () => {
  test("只列依賴都 done 的項目，依賴完成後立刻出現", async () => {
    await withWorkTools(async (context) => {
      const first = expectOk(await context.call("work_create", { title: "第一關" })).data.work;
      const second = expectOk(
        await context.call("work_create", { title: "第二關", dependsOn: [first.id] }),
      ).data.work;
      const third = expectOk(
        await context.call("work_create", { title: "第三關", dependsOn: [second.id] }),
      ).data.work;
      const independent = expectOk(
        await context.call("work_create", { title: "獨立工作" }),
      ).data.work;

      const before = expectOk(await context.call("work_ready", {}));
      expect(before.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [first.id, independent.id].sort(),
      );

      markWorkDone(context.home, first.id);

      const afterFirst = expectOk(await context.call("work_ready", {}));
      expect(afterFirst.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [independent.id, second.id].sort(),
      );

      markWorkDone(context.home, second.id);

      const afterSecond = expectOk(await context.call("work_ready", {}));
      expect(afterSecond.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [independent.id, third.id].sort(),
      );

      for (const item of afterSecond.data.items) {
        expect(item.status).toBe("open");
        expect(Array.isArray(item.dependsOn)).toBe(true);
      }
    });
  });

  test("依賴被取消時仍然阻擋，不會出現在 ready", async () => {
    await withWorkTools(async (context) => {
      const dependency = expectOk(await context.call("work_create", { title: "會取消的依賴" })).data.work;
      const waiting = expectOk(
        await context.call("work_create", { title: "等待取消的依賴", dependsOn: [dependency.id] }),
      ).data.work;

      expectOk(
        await context.call("work_update", {
          id: dependency.id,
          expectedVersion: 1,
          status: "cancelled",
        }),
      );

      const ready = expectOk(await context.call("work_ready", {}));
      expect(ready.data.items.map((item: { id: string }) => item.id)).not.toContain(waiting.id);
      expect(ready.data.items.map((item: { id: string }) => item.id)).not.toContain(dependency.id);
    });
  });

  test("進行中或阻塞的工作不算可開始", async () => {
    await withWorkTools(async (context) => {
      const inProgress = expectOk(
        await context.call("work_create", { title: "進行中" }),
      ).data.work;
      expectOk(
        await context.call("work_update", {
          id: inProgress.id,
          expectedVersion: 1,
          status: "in_progress",
        }),
      );

      const blocked = expectOk(await context.call("work_create", { title: "阻塞" })).data.work;
      expectOk(
        await context.call("work_update", {
          id: blocked.id,
          expectedVersion: 1,
          status: "blocked",
        }),
      );

      const ready = expectOk(await context.call("work_ready", {}));
      expect(ready.data.items).toEqual([]);
    });
  });
});
