import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tool as completeTool } from "../../../src/tools/work/complete.ts";
import type { ToolContext } from "../../../src/mcp/types.ts";
import { failureFromError, type ToolResult } from "../../../src/shared/result.ts";
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

  test("高風險工作只有失敗的伺服器證據時拒絕結案，補上成功的證據後可以通過", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: ["a"] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      const failed = insertEvidence(db, projectId, workId, { serverIssued: true, exitCode: 1 });
      const blocked = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [failed] }],
      });

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("SERVER_EVIDENCE_FAILED");
      expect(blocked.data.blockedBy).toContain("SERVER_EVIDENCE_FAILED");
      const afterBlocked = readWork(db, workId);
      expect(afterBlocked?.status).toBe("review");
      expect(afterBlocked?.version).toBe(2);

      const passed = insertEvidence(db, projectId, workId, { serverIssued: true, exitCode: 0 });
      const completed = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [passed] }],
      });

      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.data).toMatchObject({ status: "done", resolution: "completed" });
    });
  });

  test("逾時的伺服器證據不能單獨讓高風險工作通關", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: [] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      insertEvidence(db, projectId, workId, { serverIssued: true, timedOut: true });
      const blocked = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [],
      });

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("SERVER_EVIDENCE_FAILED");
      expect(readWork(db, workId)?.status).toBe("review");
    });
  });

  test("details 損壞的伺服器證據不能讓高風險工作結案，工作維持 review", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: [] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      const evidenceId = insertEvidence(db, projectId, workId, { serverIssued: true });
      setEvidenceDetails(db, evidenceId, "not-json");

      const blocked = await callCompleteEnvelope(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [],
      });

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("INTERNAL_ERROR");
      expect(blocked.message).toContain(evidenceId);
      expect(blocked.message).toContain("details");
      expect(blocked.data).toMatchObject({ field: "details" });

      const after = readWork(db, workId);
      expect(after?.status).toBe("review");
      expect(after?.version).toBe(2);
    });
  });

  test("details 是合法 JSON 但不是物件時也不能讓高風險工作結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: [] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      const evidenceId = insertEvidence(db, projectId, workId, { serverIssued: true });
      setEvidenceDetails(db, evidenceId, '["timedOut"]');

      const blocked = await callCompleteEnvelope(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [],
      });

      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("INTERNAL_ERROR");
      expect(readWork(db, workId)?.status).toBe("review");
    });
  });

  test("details 為合法物件且未逾時的伺服器證據仍可支撐高風險結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: ["a"] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      const evidenceId = insertEvidence(db, projectId, workId, {
        serverIssued: true,
        exitCode: 0,
        timedOut: false,
      });
      const completed = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [evidenceId] }],
      });

      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.data).toMatchObject({ status: "done", resolution: "completed" });
    });
  });

  test("沒有 exitCode 的既有伺服器證據仍可支撐高風險結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", acceptance: ["a"] });
      const review = await callReviewOnce(context, workId);
      expect(review.ok).toBe(true);

      const legacyEvidence = insertEvidence(db, projectId, workId, { serverIssued: true });
      const completed = await callComplete(context, {
        id: workId,
        expectedVersion: 2,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [legacyEvidence] }],
      });

      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.data).toMatchObject({ status: "done", resolution: "completed" });
    });
  });

  test("低風險工作不會因為伺服器證據失敗而被擋下", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "low", acceptance: ["a"] });
      const failed = insertEvidence(db, projectId, workId, { serverIssued: true, exitCode: 1 });
      const completed = await callComplete(context, {
        id: workId,
        expectedVersion: 1,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [failed] }],
      });

      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.data).toMatchObject({ status: "done", resolution: "completed" });
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

  test("open 與 blocked 不能直接結案，必須先轉 in_progress", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const open = insertWork(db, projectId, { status: "open", acceptance: [] });
      const fromOpen = await callComplete(context, { id: open, expectedVersion: 1, acceptance: [] });
      expect(fromOpen.ok).toBe(false);
      if (fromOpen.ok) return;
      expect(fromOpen.code).toBe("INVALID_TRANSITION");
      expect(fromOpen.nextAction).toContain("work_update");
      expect(fromOpen.nextAction).toContain("in_progress");
      expect(readWork(db, open)?.status).toBe("open");

      const blocked = insertWork(db, projectId, { status: "blocked", acceptance: [] });
      const fromBlocked = await callComplete(context, {
        id: blocked,
        expectedVersion: 1,
        acceptance: [],
      });
      expect(fromBlocked.ok).toBe(false);
      if (fromBlocked.ok) return;
      expect(fromBlocked.code).toBe("INVALID_TRANSITION");
      expect(fromBlocked.nextAction).toContain("work_update");
      expect(fromBlocked.nextAction).toContain("in_progress");
      expect(readWork(db, blocked)?.status).toBe("blocked");
    });
  });

  test("終態工作不能再結案", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
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

/** 直接改資料庫，把證據的 details 換成指定字串，模擬損壞或舊格式的內容。 */
function setEvidenceDetails(db: Database, evidenceId: string, details: string): void {
  db.query("UPDATE evidence SET details = ? WHERE evidence_id = ?").run(details, evidenceId);
}

/** 直接呼叫 handler 時把例外轉成 MCP 回給宿主的失敗外框，處理方式和 runTool 相同。 */
async function callCompleteEnvelope(
  context: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await callComplete(context, input);
  } catch (error) {
    return failureFromError(error);
  }
}
