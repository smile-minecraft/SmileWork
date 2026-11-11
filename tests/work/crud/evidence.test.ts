import { describe, expect, test } from "bun:test";
import { countRows, expectFail, expectOk, withWorkTools } from "./helpers.ts";

describe("work_update 的人工證據", () => {
  test("附加 link 與 note 證據，資料庫記為 serverIssued=false", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "證據測試" })).data.work;

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          evidence: [
            {
              kind: "link",
              summary: "規格文件",
              url: "https://example.com/spec",
            },
            {
              kind: "note",
              summary: "人工檢查過了",
              output: "看起來正確",
            },
          ],
        }),
      );
      expect(updated.data.work.version).toBe(2);
      expect(updated.data.evidence).toHaveLength(2);

      expect(countRows(context.home, "evidence")).toBe(2);
      const db = context.openDb();
      try {
        const rows = db
          .query<
            {
              kind: string;
              url: string | null;
              output: string | null;
              server_issued: number;
              actor: string;
              actor_model: string | null;
              project_id: string;
              work_id: string;
            },
            []
          >(
            `SELECT kind, url, output, server_issued, actor, actor_model, project_id, work_id
             FROM evidence ORDER BY kind`,
          )
          .all();
        expect(rows.map((row) => row.kind)).toEqual(["link", "note"]);
        expect(rows.every((row) => row.server_issued === 0)).toBe(true);
        expect(rows.every((row) => row.actor === "build")).toBe(true);
        expect(rows.every((row) => row.actor_model === "test-model")).toBe(true);
        expect(rows.every((row) => row.project_id === work.projectId)).toBe(true);
        expect(rows.every((row) => row.work_id === work.id)).toBe(true);
        const link = rows.find((row) => row.kind === "link");
        expect(link?.url).toBe("https://example.com/spec");
        const note = rows.find((row) => row.kind === "note");
        expect(note?.output).toBe("看起來正確");
      } finally {
        db.close();
      }

      const got = expectOk(await context.call("work_get", { id: work.id }));
      expect(got.data.evidence).toHaveLength(2);
      expect(got.data.evidence[0]).toMatchObject({
        serverIssued: false,
        actor: "build",
      });
    });
  });

  test("verify_run 缺 command、output 缺 path、link 缺 url 都回 VALIDATION_ERROR", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "證據驗證" })).data.work;

      const cases = [
        { evidence: { kind: "verify_run", summary: "沒有指令" }, nextAction: null },
        {
          evidence: { kind: "output", summary: "沒有路徑" },
          nextAction: "kind: note 或 verify_run",
        },
        { evidence: { kind: "link", summary: "沒有網址" }, nextAction: null },
      ];

      for (const entry of cases) {
        const rejected = expectFail(
          await context.call("work_update", {
            id: work.id,
            expectedVersion: 1,
            evidence: [entry.evidence],
          }),
        );
        expect(rejected.code).toBe("VALIDATION_ERROR");
        if (entry.nextAction !== null) {
          expect(rejected.nextAction).toContain(entry.nextAction);
        }
      }

      expect(countRows(context.home, "evidence")).toBe(0);
      const got = expectOk(await context.call("work_get", { id: work.id }));
      expect(got.data.work.version).toBe(1);
    });
  });

  test("output 的 path 是絕對路徑時，nextAction 給出相對路徑範例", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "路徑提示" })).data.work;
      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          evidence: [
            { kind: "output", summary: "絕對路徑", path: "/tmp/result.txt" },
          ],
        }),
      );
      expect(rejected.code).toBe("VALIDATION_ERROR");
      expect(rejected.nextAction).toContain("相對於專案根目錄");
      expect(rejected.nextAction).toContain("src/work/");
    });
  });

  test("verify_run 與 output 分別記成 command 與 artifact", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "證據種類" })).data.work;

      expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          evidence: [
            { kind: "verify_run", summary: "跑過測試", command: "bun test", output: "pass" },
            { kind: "output", summary: "產出報告", path: "reports/result.txt" },
          ],
        }),
      );

      const db = context.openDb();
      try {
        const rows = db
          .query<{ kind: string; command: string | null; path: string | null }, []>(
            "SELECT kind, command, path FROM evidence ORDER BY kind",
          )
          .all();
        expect(rows).toEqual([
          { kind: "artifact", command: null, path: "reports/result.txt" },
          { kind: "command", command: "bun test", path: null },
        ]);
      } finally {
        db.close();
      }
    });
  });

  test("第一次新增一筆證據，addedEvidence 只有該筆並包含 evidenceId", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "新增證據" })).data.work;

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          evidence: [{ kind: "note", summary: "第一筆證據", output: "內容一" }],
        }),
      );
      expect(updated.data.work.version).toBe(2);
      expect(updated.data.addedEvidence).toHaveLength(1);
      expect(updated.data.addedEvidence[0].evidenceId).toBeDefined();
      expect(updated.data.addedEvidence[0].summary).toBe("第一筆證據");
      expect(updated.data.evidence).toHaveLength(1);
      expect(updated.data.addedEvidence[0].kind).toBe("note");
      expect(updated.data.addedEvidence[0].outputPath).toBeNull();
      expect(updated.data.addedEvidence[0]).toEqual(updated.data.evidence[0]);
    });
  });

  test("第二次再新增一筆時，addedEvidence 只有第二筆", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "兩次新增" })).data.work;

      expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          evidence: [{ kind: "note", summary: "第一筆", output: "a" }],
        }),
      );

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 2,
          evidence: [{ kind: "link", summary: "第二筆", url: "https://example.com/b" }],
        }),
      );
      expect(updated.data.work.version).toBe(3);
      expect(updated.data.addedEvidence).toHaveLength(1);
      expect(updated.data.addedEvidence[0].summary).toBe("第二筆");
      expect(updated.data.evidence).toHaveLength(2);
    });
  });

  test("完全沒有新增證據時，addedEvidence 是空陣列，evidence 仍是完整清單", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "先放證據" })).data.work;

      expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 1,
          evidence: [{ kind: "note", summary: "既有證據", output: "old" }],
        }),
      );

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: 2,
          title: "只改標題",
        }),
      );
      expect(updated.data.work.version).toBe(3);
      expect(updated.data.addedEvidence).toEqual([]);
      expect(updated.data.evidence).toHaveLength(1);
      expect(updated.data.evidence[0].summary).toBe("既有證據");
    });
  });
});
