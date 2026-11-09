import { describe, expect, test } from "bun:test";
import {
  countRows,
  expectFail,
  expectOk,
  withWorkTools,
  type WorkTestContext,
} from "./helpers.ts";

function corruptIdempotencyResponse(
  context: WorkTestContext,
  tool: string,
  key: string,
  response: string,
): void {
  const db = context.openDb();
  try {
    const updated = db
      .query("UPDATE idempotency_keys SET response = ? WHERE tool = ? AND key = ?")
      .run(response, tool, key);
    expect(updated.changes).toBe(1);
  } finally {
    db.close();
  }
}

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

describe("冪等鍵快取的回應損壞", () => {
  test("work_create 的回放缺 summary/data 時回 INTERNAL_ERROR，不再假成功", async () => {
    await withWorkTools(async (context) => {
      const input = { title: "快取回放損壞", idempotencyKey: "broken-create-replay" };
      expectOk(await context.call("work_create", input));
      corruptIdempotencyResponse(context, "work_create", "broken-create-replay", '{"ok":true}');

      const replay = expectFail(await context.call("work_create", input));
      expect(replay.code).toBe("INTERNAL_ERROR");
      expect(replay.message).toContain("broken-create-replay");
      expect(replay.message).toContain("快取回放");
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });

  test("work_create 的回放不是合法 JSON 時回 INTERNAL_ERROR", async () => {
    await withWorkTools(async (context) => {
      const input = { title: "快取不是 JSON", idempotencyKey: "broken-create-json" };
      expectOk(await context.call("work_create", input));
      corruptIdempotencyResponse(context, "work_create", "broken-create-json", "not-json");

      const replay = expectFail(await context.call("work_create", input));
      expect(replay.code).toBe("INTERNAL_ERROR");
      expect(replay.message).toContain("broken-create-json");
      expect(replay.message).toContain("快取回放");
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });

  test("work_complete 的回放缺 summary/data 時回 INTERNAL_ERROR，不再假成功", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "結案快取回放損壞" }),
      ).data.work;
      const db = context.openDb();
      try {
        db.query("UPDATE work_items SET status = 'review' WHERE work_id = ?").run(work.id);
      } finally {
        db.close();
      }

      const input = {
        id: work.id,
        expectedVersion: 1,
        acceptance: [],
        idempotencyKey: "broken-complete-replay",
      };
      expectOk(await context.call("work_complete", input));
      corruptIdempotencyResponse(context, "work_complete", "broken-complete-replay", '{"ok":true}');

      const replay = expectFail(await context.call("work_complete", input));
      expect(replay.code).toBe("INTERNAL_ERROR");
      expect(replay.message).toContain("broken-complete-replay");
      expect(replay.message).toContain("快取回放");
    });
  });

  test("失敗外框缺少 nextAction 時回 INTERNAL_ERROR，不再當成合法回放", async () => {
    await withWorkTools(async (context) => {
      const input = { title: "缺 nextAction 的失敗外框", idempotencyKey: "broken-failure-next-action" };
      expectOk(await context.call("work_create", input));
      corruptIdempotencyResponse(
        context,
        "work_create",
        "broken-failure-next-action",
        '{"ok":false,"code":"VALIDATION_ERROR","message":"格式不對","data":{}}',
      );

      const replay = expectFail(await context.call("work_create", input));
      expect(replay.code).toBe("INTERNAL_ERROR");
      expect(replay.message).toContain("nextAction");
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });

  test("失敗外框缺少 data 時回 INTERNAL_ERROR，不再當成合法回放", async () => {
    await withWorkTools(async (context) => {
      const input = { title: "缺 data 的失敗外框", idempotencyKey: "broken-failure-data" };
      expectOk(await context.call("work_create", input));
      corruptIdempotencyResponse(
        context,
        "work_create",
        "broken-failure-data",
        '{"ok":false,"code":"VALIDATION_ERROR","message":"格式不對","nextAction":"修正後再試一次。"}',
      );

      const replay = expectFail(await context.call("work_create", input));
      expect(replay.code).toBe("INTERNAL_ERROR");
      expect(replay.message).toContain("data");
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });

  test("完整的失敗外框仍可回放", async () => {
    await withWorkTools(async (context) => {
      const input = { title: "完整的失敗外框", idempotencyKey: "legal-failure-replay" };
      expectOk(await context.call("work_create", input));
      corruptIdempotencyResponse(
        context,
        "work_create",
        "legal-failure-replay",
        JSON.stringify({
          ok: false,
          code: "VALIDATION_ERROR",
          message: "格式不對",
          nextAction: "修正後再試一次。",
          data: { field: "title" },
        }),
      );

      const replay = expectFail(await context.call("work_create", input));
      expect(replay.code).toBe("VALIDATION_ERROR");
      expect(replay.message).toBe("格式不對");
      expect(replay.nextAction).toBe("修正後再試一次。");
      expect(replay.data).toEqual({ field: "title" });
      expect(countRows(context.home, "work_items")).toBe(1);
    });
  });
});
