import { describe, expect, test } from "bun:test";
import { expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("work_list", () => {
  test("依 status、owner、parentId、label 篩選並支援分頁", async () => {
    await withWorkTools(async (context) => {
      const plan = expectOk(
        await context.call("work_create", { kind: "plan", title: "清單測試計畫", owner: "arch" }),
      ).data.work;

      const first = expectOk(
        await context.call("work_create", {
          title: "第一項",
          parentId: plan.id,
          owner: "alice",
          labels: ["backend", "urgent"],
        }),
      ).data.work;
      const second = expectOk(
        await context.call("work_create", {
          title: "第二項",
          parentId: plan.id,
          owner: "bob",
          labels: ["frontend"],
        }),
      ).data.work;
      const third = expectOk(
        await context.call("work_create", { title: "第三項", owner: "alice", labels: ["backend"] }),
      ).data.work;

      expectOk(
        await context.call("work_update", {
          id: second.id,
          expectedVersion: 1,
          status: "in_progress",
        }),
      );

      const all = expectOk(await context.call("work_list", {}));
      expect(all.data.items).toHaveLength(4);
      expect(all.data.nextCursor).toBeNull();

      const inProgress = expectOk(await context.call("work_list", { status: ["in_progress"] }));
      expect(inProgress.data.items.map((item: { id: string }) => item.id)).toEqual([second.id]);

      const byOwner = expectOk(await context.call("work_list", { owner: "alice" }));
      expect(byOwner.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [first.id, third.id].sort(),
      );

      const byParent = expectOk(await context.call("work_list", { parentId: plan.id }));
      expect(byParent.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );

      const byLabel = expectOk(await context.call("work_list", { label: "backend" }));
      expect(byLabel.data.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [first.id, third.id].sort(),
      );

      const byKind = expectOk(await context.call("work_list", { kind: "plan" }));
      expect(byKind.data.items.map((item: { id: string }) => item.id)).toEqual([plan.id]);

      const pageOne = expectOk(await context.call("work_list", { limit: 2 }));
      expect(pageOne.data.items).toHaveLength(2);
      expect(typeof pageOne.data.nextCursor).toBe("string");

      const pageTwo = expectOk(
        await context.call("work_list", { limit: 2, cursor: pageOne.data.nextCursor }),
      );
      expect(pageTwo.data.items).toHaveLength(2);
      expect(pageTwo.data.nextCursor).toBeNull();

      const ids = new Set([
        ...pageOne.data.items.map((item: { id: string }) => item.id),
        ...pageTwo.data.items.map((item: { id: string }) => item.id),
      ]);
      expect(ids.size).toBe(4);
      for (const item of [...pageOne.data.items, ...pageTwo.data.items]) {
        expect(item).toMatchObject({ status: expect.any(String) });
        expect(typeof item.version).toBe("number");
        expect(Array.isArray(item.dependsOn)).toBe(true);
        expect(Array.isArray(item.labels)).toBe(true);
      }
    });
  });

  test("預設不列 done 與 cancelled", async () => {
    await withWorkTools(async (context) => {
      const openWork = expectOk(await context.call("work_create", { title: "未結案" })).data.work;
      const cancelled = expectOk(await context.call("work_create", { title: "要取消" })).data.work;
      expectOk(
        await context.call("work_update", {
          id: cancelled.id,
          expectedVersion: 1,
          status: "cancelled",
        }),
      );

      const listed = expectOk(await context.call("work_list", {}));
      expect(listed.data.items.map((item: { id: string }) => item.id)).toEqual([openWork.id]);

      const explicitlyCancelled = expectOk(
        await context.call("work_list", { status: ["cancelled"] }),
      );
      expect(explicitlyCancelled.data.items.map((item: { id: string }) => item.id)).toEqual([
        cancelled.id,
      ]);
    });
  });

  test("無效的 cursor 回 VALIDATION_ERROR", async () => {
    await withWorkTools(async (context) => {
      const result = expectFail(await context.call("work_list", { cursor: "work-missing" }));
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });
});
