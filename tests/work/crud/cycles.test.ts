import { describe, expect, test } from "bun:test";
import { expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("依賴成環", () => {
  test("A 依賴 B、B 依賴 A 時拒絕更新", async () => {
    await withWorkTools(async (context) => {
      const a = expectOk(await context.call("work_create", { title: "工作 A" })).data.work;
      const b = expectOk(
        await context.call("work_create", { title: "工作 B", dependsOn: [a.id] }),
      ).data.work;

      const rejected = expectFail(
        await context.call("work_update", {
          id: a.id,
          expectedVersion: 1,
          addDependsOn: [b.id],
        }),
      );
      expect(rejected.code).toBe("DEPENDENCY_CYCLE");
      expect(Array.isArray(rejected.data.cycle)).toBe(true);

      const checked = expectOk(await context.call("work_get", { id: a.id }));
      expect(checked.data.work.dependsOn).toEqual([]);
    });
  });

  test("自己依賴自己會被拒絕", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "自我依賴" })).data.work;

      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          addDependsOn: [work.id],
        }),
      );
      expect(rejected.code).toBe("DEPENDENCY_CYCLE");
    });
  });

  test("間接成環也會被拒絕", async () => {
    await withWorkTools(async (context) => {
      const a = expectOk(await context.call("work_create", { title: "A" })).data.work;
      const b = expectOk(
        await context.call("work_create", { title: "B", dependsOn: [a.id] }),
      ).data.work;
      const c = expectOk(
        await context.call("work_create", { title: "C", dependsOn: [b.id] }),
      ).data.work;

      const rejected = expectFail(
        await context.call("work_update", {
          id: a.id,
          expectedVersion: 1,
          addDependsOn: [c.id],
        }),
      );
      expect(rejected.code).toBe("DEPENDENCY_CYCLE");
      expect((rejected.data.cycle as string[])[0]).toBe(c.id);
    });
  });

  test("加入不存在的依賴回 WORK_NOT_FOUND", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "缺依賴" })).data.work;
      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          addDependsOn: ["work-missing"],
        }),
      );
      expect(rejected.code).toBe("WORK_NOT_FOUND");
      expect(rejected.data).toMatchObject({ id: "work-missing" });
    });
  });
});
