import { describe, expect, test } from "bun:test";
import { tool as completeTool } from "../../../src/tools/work/complete.ts";
import type { ToolContext } from "../../../src/mcp/types.ts";
import type { ToolResult } from "../../../src/shared/result.ts";
import {
  callComplete,
  callReview,
  countEvents,
  insertDependency,
  insertEvidence,
  insertWork,
  readWork,
  withLifecycle,
} from "./helpers.ts";

describe("work_complete 的介面", () => {
  test("schema 要求 id、expectedVersion 與逐項驗收結果", () => {
    expect(completeTool.inputSchema.safeParse({ id: "work-1", acceptance: [] }).success).toBe(false);
    expect(
      completeTool.inputSchema.safeParse({ id: "work-1", expectedVersion: 1, acceptance: [] }).success,
    ).toBe(true);
    expect(
      completeTool.inputSchema.safeParse({ id: "work-1", expectedVersion: 0, acceptance: [] }).success,
    ).toBe(false);
    expect(
      completeTool.inputSchema.safeParse({
        id: "work-1",
        expectedVersion: 1,
        acceptance: [{ criterion: "a", met: true }],
      }).success,
    ).toBe(true);
  });

  test("成功外框固定為 ok、summary、data", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["a"] });
      const evidenceId = insertEvidence(db, projectId, workId);
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(true);
      expect(Object.keys(result).sort()).toEqual(["data", "ok", "summary"]);
    });
  });
});

describe("work_complete 的結案條件", () => {
  test("所有驗收都達成且有證據時可以結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["第一項", "第二項"] });
      const evidenceId = insertEvidence(db, projectId, workId);
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [
          { criterion: "第二項", met: true, evidenceIds: [evidenceId] },
          { criterion: "第一項", met: true, evidenceIds: [evidenceId] },
        ],
        note: "兩項都驗過了",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toMatchObject({
        workId,
        status: "done",
        resolution: "completed",
        version: 2,
      });

      const row = readWork(db, workId);
      expect(row?.status).toBe("done");
      expect(row?.resolution).toBe("completed");
      expect(row?.version).toBe(2);
      const acceptanceResults = JSON.parse(row?.acceptance_results ?? "null") as {
        recordedBy: string;
        items: Array<{ criterion: string; met: boolean; evidenceIds: string[] }>;
      };
      expect(acceptanceResults.recordedBy).toBe("build");
      expect(acceptanceResults.items.map((item) => item.criterion)).toEqual(["第一項", "第二項"]);
      expect(countEvents(db, projectId, workId)).toBe(1);
    });
  });

  test("缺一條驗收時拒絕結案並列出缺少的項目", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["a", "b"] });
      const evidenceId = insertEvidence(db, projectId, workId);
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [evidenceId] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(result.data.missing).toEqual(["b"]);
      expect(readWork(db, workId)?.status).toBe("review");
    });
  });

  test("驗收結果 met=false 時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["a", "b"] });
      const evidenceId = insertEvidence(db, projectId, workId);
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [
          { criterion: "a", met: true, evidenceIds: [evidenceId] },
          { criterion: "b", met: false, evidenceIds: [evidenceId] },
        ],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(result.data.unmet).toEqual(["b"]);
    });
  });

  test("驗收項目與工作定義不一致時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["a"] });
      const evidenceId = insertEvidence(db, projectId, workId);
      const unknown = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "不是工作定義的條件", met: true, evidenceIds: [evidenceId] }],
      });

      expect(unknown.ok).toBe(false);
      if (unknown.ok) return;
      expect(unknown.code).toBe("ACCEPTANCE_INCOMPLETE");
      expect(unknown.data.missing).toEqual(["a"]);
      expect(unknown.data.unknown).toEqual(["不是工作定義的條件"]);
    });
  });

  test("met=true 但沒有 evidenceId 時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["a", "b"] });
      const evidenceId = insertEvidence(db, projectId, workId);
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [
          { criterion: "a", met: true, evidenceIds: [] },
          { criterion: "b", met: true, evidenceIds: [evidenceId] },
        ],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("EVIDENCE_REQUIRED");
      expect(result.data.criteriaWithoutEvidence).toEqual(["a"]);
    });
  });

  test("引用不存在或屬於其他工作的 evidenceId 時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: ["a"] });
      const otherWorkId = insertWork(db, projectId, {});
      const foreignEvidence = insertEvidence(db, projectId, otherWorkId);
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [foreignEvidence] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("EVIDENCE_REQUIRED");
      expect(result.data.missingEvidenceIds).toEqual([foreignEvidence]);
    });
  });

  test("高風險項目沒有 approve 時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: [] });
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("REVIEW_REQUIRED");
    });
  });

  test("高風險項目的審查結論不是 approve 時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        risk: "high",
        acceptance: [],
        review: { verdict: "concerns", reviewer: "momus", reviewedVersion: 1 },
      });
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("REVIEW_REQUIRED");
      expect(result.data.verdict).toBe("concerns");
    });
  });

  test("高風險項目的 approve 由 owner 記錄時拒絕結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, {
        risk: "high",
        acceptance: [],
        owner: "build",
        review: { verdict: "approve", reviewer: "build", reviewedVersion: 1 },
      });
      insertEvidence(db, projectId, workId, { serverIssued: true });
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("REVIEWER_IS_OWNER");
    });
  });

  test("高風險項目缺少伺服器證據時拒絕結案，補上後可以通過", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: ["a"] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      const humanEvidence = insertEvidence(db, projectId, workId, { serverIssued: false });
      const blocked = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [humanEvidence] }],
      });

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("SERVER_EVIDENCE_REQUIRED");

      const serverEvidence = insertEvidence(db, projectId, workId, { serverIssued: true });
      const passed = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [serverEvidence] }],
      });

      expect(passed.ok).toBe(true);
      if (!passed.ok) return;
      expect(passed.data).toMatchObject({ status: "done", resolution: "completed" });
    });
  });

  test("依賴未完成時拒絕結案，依賴取消時提供可操作的下一步", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: [] });
      const dependencyId = insertWork(db, projectId, { status: "in_progress" });
      insertDependency(db, workId, dependencyId);

      const pending = await callComplete(context, { id: workId, expectedVersion: 1, acceptance: [] });
      expect(pending.ok).toBe(false);
      if (pending.ok) return;
      expect(pending.code).toBe("DEPENDENCY_NOT_DONE");
      expect(pending.nextAction).toContain("完成");

      db.query("UPDATE work_items SET status = 'cancelled', resolution = 'abandoned' WHERE work_id = ?").run(
        dependencyId,
      );
      const cancelled = await callComplete(context, { id: workId, expectedVersion: 1, acceptance: [] });
      expect(cancelled.ok).toBe(false);
      if (cancelled.ok) return;
      expect(cancelled.code).toBe("DEPENDENCY_NOT_DONE");
      expect(cancelled.nextAction).toContain("移除");
      expect(cancelled.nextAction).toContain("取消本項");

      db.query("UPDATE work_items SET status = 'done', resolution = 'completed' WHERE work_id = ?").run(
        dependencyId,
      );
      const passed = await callComplete(context, { id: workId, expectedVersion: 1, acceptance: [] });
      expect(passed.ok).toBe(true);
    });
  });

  test("同一個 idempotencyKey 重送只結案一次", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: [] });
      const input = {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
        idempotencyKey: "complete-once",
      };

      const first = await callComplete(context, input);
      const second = await callComplete(context, input);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data).toEqual(first.data);
      expect(readWork(db, workId)?.version).toBe(2);
      expect(countEvents(db, projectId, workId)).toBe(1);

      const keys = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM idempotency_keys WHERE project_id = ? AND tool = 'work_complete'",
        )
        .get(projectId);
      expect(keys?.count).toBe(1);
    });
  });

  test("同一個 idempotencyKey 搭配不同請求時拒絕重送", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: [] });
      await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
        idempotencyKey: "complete-conflict",
      });

      const conflict = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
        idempotencyKey: "complete-conflict",
        note: "不同的請求",
      });

      expect(conflict.ok).toBe(false);
      if (conflict.ok) return;
      expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });
});

describe("work_complete 的錯誤情況", () => {
  test("找不到工作時回 WORK_NOT_FOUND", async () => {
    await withLifecycle(async ({ context }) => {
      const result = await callComplete(context, {
        id: "work-does-not-exist",
        expectedVersion: 1,
        acceptance: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("WORK_NOT_FOUND");
    });
  });

  test("版本不符時回 VERSION_CONFLICT 並附目前版本", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { acceptance: [], version: 3 });
      const result = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("VERSION_CONFLICT");
      expect(result.data.currentVersion).toBe(3);
    });
  });

  test("非法狀態轉移被拒絕", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const inProgress = insertWork(db, projectId, { status: "in_progress", acceptance: [] });
      const fromInProgress = await callComplete(context, {
        id: inProgress,
        expectedVersion: 1,
        acceptance: [],
      });
      expect(fromInProgress.ok).toBe(false);
      if (fromInProgress.ok) return;
      expect(fromInProgress.code).toBe("INVALID_TRANSITION");

      const done = insertWork(db, projectId, {
        status: "done",
        resolution: "completed",
        acceptance: [],
      });
      const fromDone = await callComplete(context, { id: done, expectedVersion: 1, acceptance: [] });
      expect(fromDone.ok).toBe(false);
      if (fromDone.ok) return;
      expect(fromDone.code).toBe("INVALID_TRANSITION");

      const cancelled = insertWork(db, projectId, {
        status: "cancelled",
        resolution: "abandoned",
        acceptance: [],
      });
      const fromCancelled = await callComplete(context, {
        id: cancelled,
        expectedVersion: 1,
        acceptance: [],
      });
      expect(fromCancelled.ok).toBe(false);
      if (fromCancelled.ok) return;
      expect(fromCancelled.code).toBe("INVALID_TRANSITION");
    });
  });
});

async function callReviewOnce(context: ToolContext, workId: string): Promise<ToolResult> {
  return callReview(context, {
    id: workId,
    expectedVersion: 1,
    verdict: "approve",
    reviewer: "momus",
    note: "獨立看過",
  });
}
