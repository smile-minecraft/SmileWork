import { describe, expect, test } from "bun:test";
import { expectOk, withWorkTools } from "./helpers.ts";

describe("工作事件的稽核紀錄", () => {
  test("建立與更新會留下 created、status_changed、evidence_added、note 事件", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", {
          kind: "plan",
          title: "事件測試",
          objective: "確認事件順序。",
        }),
      ).data.work;

      expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          status: "in_progress",
          title: "事件測試（更新）",
          evidence: [{ kind: "note", summary: "更新時附加的筆記" }],
        }),
      );

      const db = context.openDb();
      try {
        const rows = db
          .query<
            {
              sequence: number;
              kind: string;
              actor: string;
              actor_model: string | null;
              work_id: string;
              project_id: string;
              from_status: string | null;
              to_status: string | null;
              resolution: string | null;
            },
            []
          >(
            `SELECT sequence, kind, actor, actor_model, work_id, project_id,
                    from_status, to_status, resolution
             FROM events ORDER BY sequence`,
          )
          .all();

        expect(rows.map((row) => row.kind)).toEqual([
          "created",
          "status_changed",
          "evidence_added",
          "note",
        ]);
        expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
        expect(rows.every((row) => row.actor === "build")).toBe(true);
        expect(rows.every((row) => row.actor_model === "test-model")).toBe(true);
        expect(rows.every((row) => row.work_id === work.id)).toBe(true);
        expect(rows.every((row) => row.project_id === work.projectId)).toBe(true);
        expect(rows[1]).toMatchObject({
          from_status: "open",
          to_status: "in_progress",
          resolution: null,
        });
      } finally {
        db.close();
      }
    });
  });
});
