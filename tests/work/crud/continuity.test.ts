import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { openDatabase } from "../../../src/db/index.ts";
import { runTool } from "../../../src/mcp/result.ts";
import { toolByName } from "../../../src/mcp/registry.ts";
import { withTempDir, withTempHome } from "../../helpers/temp.ts";
import { expectFail, expectOk, withWorkTools } from "./helpers.ts";

function gitHead(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function countContinuityEvents(home: string, workId: string): { handoff: number; ruling: number } {
  const db = openDatabase({ home });
  try {
    const rows = db
      .query<{ kind: string; count: number }, [string]>(
        `SELECT kind, COUNT(*) AS count FROM events
         WHERE work_id = ? AND kind IN ('handoff', 'ruling') GROUP BY kind`,
      )
      .all(workId);
    return {
      handoff: rows.find((row) => row.kind === "handoff")?.count ?? 0,
      ruling: rows.find((row) => row.kind === "ruling")?.count ?? 0,
    };
  } finally {
    db.close();
  }
}

describe("交接與決定紀錄", () => {
  test("work_update 留下交接與 rulings，work_get 與 brief 都看得到", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "跨代理接續" })).data.work;
      expect(work.baseCommit).toBe(gitHead(context.projectPath));

      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          evidence: [
            {
              kind: "handoff",
              summary: "交接待審查",
              details: {
                currentState: "資料層完成，工具層還沒接。",
                decisions: ["沿用 events 儲存交接，不新增欄位"],
                nextSteps: ["接上 work_get", "補測試"],
                unverified: ["舊資料庫的 migration"],
              },
            },
            {
              kind: "ruling",
              summary: "交接放在 events",
              details: {
                decision: "交接放在 events",
                rationale: "匯出格式已經包含 events，不需要改公開格式。",
                costIfWrong: "查詢要自己挑最新一筆，效能比欄位差。",
              },
            },
          ],
        }),
      );

      const detail = expectOk(
        await context.call("work_get", { id: work.id, format: "full" }),
      ).data;
      expect(detail.handoff).toMatchObject({
        currentState: "資料層完成，工具層還沒接。",
        decisions: ["沿用 events 儲存交接，不新增欄位"],
        nextSteps: ["接上 work_get", "補測試"],
        unverified: ["舊資料庫的 migration"],
      });
      expect(detail.rulings).toHaveLength(1);
      expect(detail.rulings[0]).toMatchObject({
        decision: "交接放在 events",
        rationale: "匯出格式已經包含 events，不需要改公開格式。",
        costIfWrong: "查詢要自己挑最新一筆，效能比欄位差。",
      });

      const brief = expectOk(
        await context.call("work_get", { id: work.id, format: "brief" }),
      ).data.brief as string;
      expect(brief).toContain(`git diff ${work.baseCommit}`);
      expect(brief).toContain("## 交接紀錄");
      expect(brief).toContain("## 決定紀錄");
      expect(brief).toContain("交接放在 events");
      expect(updated.data.work.version).toBeGreaterThan(work.version);
    });
  });

  test("同一個 idempotencyKey 重送不會重複寫入交接或 rulings", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "重送回放" })).data.work;
      const input = {
        id: work.id,
        expectedVersion: work.version,
        idempotencyKey: "handoff-replay",
        evidence: [
          {
            kind: "handoff",
            summary: "交接進行中",
            details: {
              currentState: "進行中",
              decisions: ["先用最簡單的版本"],
              nextSteps: [],
              unverified: [],
            },
          },
          {
            kind: "ruling",
            summary: "先做最小版本",
            details: {
              decision: "先做最小版本",
              rationale: "先驗證流程",
              costIfWrong: "之後要重構",
            },
          },
        ],
      };
      expectOk(await context.call("work_update", input));
      expectOk(await context.call("work_update", input));

      expect(countContinuityEvents(context.home, work.id)).toEqual({ handoff: 1, ruling: 1 });
    });
  });

  test("審查與結案的回傳都帶最新交接與 rulings", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(
        await context.call("work_create", { title: "審查看得到" }),
      ).data.work;
      const moved = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "in_progress",
          evidence: [
            {
              kind: "handoff",
              summary: "交接待審查",
              details: {
                currentState: "待審查",
                decisions: ["沒有新增依賴"],
                nextSteps: ["送審"],
                unverified: [],
              },
            },
            {
              kind: "ruling",
              summary: "沒有新增依賴",
              details: { decision: "沒有新增依賴", rationale: "這次只改訊息" },
            },
          ],
        }),
      ).data.work;

      const review = expectOk(
        await context.call("work_review", {
          id: work.id,
          expectedVersion: moved.version,
          verdict: "approve",
          reviewer: "reviewer",
          note: "看過",
        }),
      ).data;
      expect(review.handoff).toMatchObject({ currentState: "待審查" });
      expect(review.rulings).toHaveLength(1);

      const completed = expectOk(
        await context.call("work_complete", {
          id: work.id,
          expectedVersion: review.version,
          acceptance: [],
        }),
      ).data;
      expect(completed.handoff).toMatchObject({ currentState: "待審查" });
      expect(completed.rulings).toHaveLength(1);
    });
  });

  test("非 git 專案建立的工作沒有 baseCommit，brief 也不列審查指令", async () => {
    await withTempHome("continuity-nongit", async (home) => {
      await withTempDir("continuity-nongit-cwd", async (cwd) => {
        const tool = toolByName("work_create");
        if (!tool) throw new Error("registry 缺少 work_create。");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SMILEWORK_HOME: home,
          SMILEWORK_ACTOR: "build",
        };
        delete env.SMILEWORK_PROJECT;

        const block = (await runTool(tool, { title: "非 git 接續" }, { env, cwd })).content[0];
        const payload = JSON.parse(block?.type === "text" ? block.text : "{}") as Record<string, any>;
        expect(payload.ok).toBe(true);
        expect(payload.data.work.baseCommit).toBeNull();

        const getTool = toolByName("work_get");
        if (!getTool) throw new Error("registry 缺少 work_get。");
        const briefBlock = (
          await runTool(getTool, { id: payload.data.work.id, format: "brief" }, { env, cwd })
        ).content[0];
        const brief = JSON.parse(briefBlock?.type === "text" ? briefBlock.text : "{}").data.brief;
        expect(brief).not.toContain("git diff");
      });
    });
  });

  test("交接格式錯誤時回 VALIDATION_ERROR，不寫入事件", async () => {
    await withWorkTools(async (context) => {
      const work = expectOk(await context.call("work_create", { title: "格式錯誤" })).data.work;
      const failed = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          evidence: [
            {
              kind: "handoff",
              summary: "格式錯誤",
              details: { currentState: "   ", decisions: [], nextSteps: [], unverified: [] },
            },
          ],
        }),
      );
      expect(failed.code).toBe("VALIDATION_ERROR");
      expect(countContinuityEvents(context.home, work.id)).toEqual({ handoff: 0, ruling: 0 });
    });
  });
});
