import { describe, expect, test } from "bun:test";
import { countRows, expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("work_create 的 idempotencyKey", () => {
  test("同一個 key 重送只產生一筆，回傳相同結果", async () => {
    await withWorkTools(async (context) => {
      const input = {
        title: "重送測試",
        objective: "確認冪等。",
        acceptance: ["只建立一筆"],
        idempotencyKey: "create-once",
      };

      const first = expectOk(await context.call("work_create", input));
      const second = expectOk(await context.call("work_create", input));

      expect(second.data.work.id).toBe(first.data.work.id);
      expect(second.data.work.version).toBe(1);
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });

  test("同一個 key 換內容回 IDEMPOTENCY_CONFLICT", async () => {
    await withWorkTools(async (context) => {
      expectOk(
        await context.call("work_create", { title: "第一次", idempotencyKey: "reused-key" }),
      );

      const conflict = expectFail(
        await context.call("work_create", { title: "換內容", idempotencyKey: "reused-key" }),
      );
      expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });

  test("不同 key 各自建立一筆", async () => {
    await withWorkTools(async (context) => {
      const first = expectOk(
        await context.call("work_create", { title: "第一筆", idempotencyKey: "key-1" }),
      );
      const second = expectOk(
        await context.call("work_create", { title: "第二筆", idempotencyKey: "key-2" }),
      );

      expect(first.data.work.id).not.toBe(second.data.work.id);
      expect(countRows(context.home, "work_items")).toBe(2);
    });
  });

  test("work_update 重送同一個 key 回傳第一次的結果，不會再升版本", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "更新前" })).data.work;
      const input = {
        id: work.id,
        expectedVersion: 1,
        title: "更新後",
        idempotencyKey: "update-once",
      };

      const first = expectOk(await context.call("work_update", input));
      expect(first.data.work.version).toBe(2);

      const replay = expectOk(await context.call("work_update", input));
      expect(replay.data.work.version).toBe(2);
      expect(replay.data.work.title).toBe("更新後");

      const reread = expectOk(await context.call("work_get", { id: work.id }));
      expect(reread.data.work.version).toBe(2);
    });
  });
});
