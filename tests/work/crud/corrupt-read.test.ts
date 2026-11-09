import { describe, expect, test } from "bun:test";
import { expectFail, expectOk, withWorkTools, type WorkTestContext } from "./helpers.ts";

type WorkArrayColumn = "non_goals" | "context_refs" | "scope_paths" | "acceptance";

function corruptWorkColumn(
  context: WorkTestContext,
  workId: string,
  column: WorkArrayColumn,
  value: string,
): void {
  const db = context.openDb();
  try {
    const updated = db
      .query(`UPDATE work_items SET ${column} = ? WHERE work_id = ?`)
      .run(value, workId);
    expect(updated.changes).toBe(1);
  } finally {
    db.close();
  }
}

describe("work 工具讀到損壞的 JSON 欄位", () => {
  test("non_goals 不是 JSON 時 work_get 回 INTERNAL_ERROR，訊息含工作 id 與欄位", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "損壞的 non_goals", nonGoals: ["原始條件"] }),
      ).data.work;
      corruptWorkColumn(context, work.id, "non_goals", "not-json");

      const failure = expectFail(await context.call("work_get", { id: work.id }));
      expect(failure.code).toBe("INTERNAL_ERROR");
      expect(failure.message).toContain(work.id);
      expect(failure.message).toContain("non_goals");
      expect(failure.data).toMatchObject({ id: work.id, field: "non_goals" });
    });
  });

  test("non_goals 含非字串元素時 work_get 回 INTERNAL_ERROR，不當成空陣列", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "混合型別的 non_goals", nonGoals: ["原始條件"] }),
      ).data.work;
      corruptWorkColumn(context, work.id, "non_goals", '["原始條件", 1]');

      const failure = expectFail(await context.call("work_get", { id: work.id }));
      expect(failure.code).toBe("INTERNAL_ERROR");
      expect(failure.message).toContain(work.id);
      expect(failure.message).toContain("non_goals");
    });
  });

  test("work_complete 讀到損壞的 non_goals 時回 INTERNAL_ERROR，不是沒有錯誤碼的錯誤", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "結案前讀到損壞欄位" }),
      ).data.work;
      corruptWorkColumn(context, work.id, "non_goals", "not-json");

      const failure = expectFail(
        await context.call("work_complete", {
          id: work.id,
          expectedVersion: 1,
          acceptance: [],
        }),
      );
      expect(failure.code).toBe("INTERNAL_ERROR");
      expect(failure.message).toContain(work.id);
      expect(failure.message).toContain("non_goals");
    });
  });
});
