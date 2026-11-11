import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { exportCurrent } from "../../../src/export/current/index.ts";
import { tool as completeTool } from "../../../src/tools/work/complete.ts";
import {
  callComplete,
  callUpdate,
  insertEvidence,
  insertWork,
  readWork,
  withLifecycle,
} from "./helpers.ts";

interface WorkReference {
  status: string;
  version: number;
}

describe("work_complete 的狀態規則", () => {
  test("工具描述說明非高風險可直接結案、高風險需要非 owner 審查", () => {
    expect(completeTool.description).toContain("in_progress");
    expect(completeTool.description).toContain("非高風險");
    expect(completeTool.description).toContain("非 owner");
  });

  test("非高風險工作從 in_progress 可以直接結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      for (const risk of ["low", "medium", null] as const) {
        const workId = insertWork(db, projectId, {
          status: "in_progress",
          risk,
          acceptance: ["項目"],
        });
        const evidenceId = insertEvidence(db, projectId, workId);

        const result = await callComplete(context, {
          id: workId,
          expectedVersion: 1,
          acceptance: [{ criterion: "項目", met: true, evidenceIds: [evidenceId] }],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data).toMatchObject({ status: "done", resolution: "completed", version: 2 });
        expect(readWork(db, workId)?.status).toBe("done");
      }
    });
  });

  test("高風險工作從 in_progress 不能直接結案，nextAction 指向非 owner 審查", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "high",
        acceptance: [],
      });

      const result = await callComplete(context, { id: workId, expectedVersion: 1, acceptance: [] });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INVALID_TRANSITION");
      expect(result.nextAction).toContain("work_review");
      expect(result.nextAction).toContain("非 owner");
      expect(result.data.blockedBy).toContain("REVIEW_REQUIRED");
      expect(readWork(db, workId)?.status).toBe("in_progress");
    });
  });

  test("目前版本的 reject 會擋住低風險直接結案，工作改版後才放行", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "review",
        risk: "low",
        acceptance: [],
        review: { verdict: "reject", reviewer: "momus", reviewedVersion: 1 },
      });

      const blocked = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
      });

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("REVIEW_REQUIRED");
      expect(blocked.message).toContain("reject");
      expect(blocked.nextAction).toContain("work_review");
      expect(blocked.data.reviewedVersion).toBe(1);
      expect(readWork(db, workId)?.status).toBe("review");

      const reworked = await callUpdate(context, {
        id: workId,
        expectedVersion: 1,
        status: "in_progress",
      });
      expect(reworked.ok).toBe(true);
      if (!reworked.ok) return;
      const updated = reworked.data as { work: WorkReference };
      expect(updated.work).toMatchObject({ status: "in_progress", version: 2 });

      const completed = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [],
      });
      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.data).toMatchObject({ status: "done", version: 3 });
    });
  });
});

describe("work_complete 的驗收字串比對", () => {
  test("全形與連續空白差異可以匹配，回傳保留工作定義的原始字串", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance: ["ＡＢＣ　１２３", "第一項    內容"],
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [
          { criterion: "ABC 123", met: true, evidenceIds: [evidenceId] },
          { criterion: "第一項 內容", met: true, evidenceIds: [evidenceId] },
        ],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const acceptanceResults = (
        result.data as { acceptanceResults: { items: Array<{ criterion: string }> } }
      ).acceptanceResults;
      expect(acceptanceResults.items.map((item) => item.criterion)).toEqual([
        "ＡＢＣ　１２３",
        "第一項    內容",
      ]);

      const stored = JSON.parse(readWork(db, workId)?.acceptance_results ?? "null") as {
        items: Array<{ criterion: string }>;
      };
      expect(stored.items.map((item) => item.criterion)).toEqual(["ＡＢＣ　１２３", "第一項    內容"]);
    });
  });

  test("結案後保留工作定義的原始驗收字串，匯出不會出現對齊警告", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance: [" 第一項 "],
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "第一項", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = JSON.parse(readWork(db, workId)?.acceptance_results ?? "null") as {
        items: Array<{ criterion: string }>;
      };
      expect(stored.items[0]?.criterion).toBe(" 第一項 ");

      const home = dirname(db.filename);
      const exported = exportCurrent({
        outDir: join(home, "export-check"),
        home,
        dbPath: db.filename,
        projectId,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(exported.warnings).not.toContain(`DATABASE_ACCEPTANCE_MISMATCH ${workId}`);
    });
  });

  test("正規化後相同的兩條驗收條件改用原始字串精確比對，不會一條結果同時滿足兩條", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance: ["a b", "a  b"],
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const partial = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "a b", met: true, evidenceIds: [evidenceId] }],
      });

      expect(partial.ok).toBe(false);
      if (partial.ok) return;
      expect(partial.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(partial.data.missing).toEqual(["a  b"]);
      expect(readWork(db, workId)?.status).toBe("in_progress");

      const completed = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [
          { criterion: "a b", met: true, evidenceIds: [evidenceId] },
          { criterion: "a  b", met: true, evidenceIds: [evidenceId] },
        ],
      });
      expect(completed.ok).toBe(true);
    });
  });

  test("真的不一致時指出缺少哪一項，並附上最接近的回報與距離", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance: ["內容"],
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "内容", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(result.data.missing).toEqual(["內容"]);
      expect(result.data.unknown).toEqual(["内容"]);
      expect(result.data.suggestions).toEqual([
        { missing: "內容", reported: "内容", distance: 1 },
      ]);
      expect(result.message).toContain("缺少「內容」");
      expect(result.message).toContain("最接近的回報是「内容」");
      expect(result.message).toContain("差 1 個字");
    });
  });

  test("兩個字的驗收條件不會把距離 2 的回報當成最接近候選", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance: ["完成"],
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "失敗", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(result.data.suggestions).toEqual([]);
      expect(result.message).not.toContain("最接近");
    });
  });

  test("差距太大的回報不會被當成最接近的候選", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance: ["部署流程完成"],
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "完全無關的項目", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(result.data.suggestions).toEqual([]);
      expect(result.message).toContain("缺少「部署流程完成」");
      expect(result.message).not.toContain("最接近");
    });
  });

  test("message 最多列出 3 條缺少的驗收條件，其餘用另有帶過", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const acceptance = Array.from({ length: 10 }, (_, index) => `項目 ${index + 1}`);
      const workId = insertWork(db, projectId, {
        status: "in_progress",
        risk: "low",
        acceptance,
      });
      const evidenceId = insertEvidence(db, projectId, workId);

      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "項目 1", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(result.data.missing).toHaveLength(9);
      expect(result.message.match(/缺少「/g)).toHaveLength(3);
      expect(result.message).toContain("另有 6 條缺少");
      expect(result.message).not.toContain("項目 10");
    });
  });
});
