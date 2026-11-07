import { describe, expect, test } from "bun:test";
import { tool as reviewTool } from "../../../src/tools/work/review.ts";
import {
  callComplete,
  callReview,
  insertEvidence,
  insertWork,
  readWork,
  withLifecycle,
} from "./helpers.ts";

describe("work_review 的介面", () => {
  test("schema 只接受 approve、concerns 與 reject", () => {
    expect(
      reviewTool.inputSchema.safeParse({ id: "work-1", expectedVersion: 1, verdict: "approve" }).success,
    ).toBe(true);
    expect(
      reviewTool.inputSchema.safeParse({ id: "work-1", expectedVersion: 1, verdict: "ok" }).success,
    ).toBe(false);
    expect(reviewTool.inputSchema.safeParse({ id: "work-1", verdict: "approve" }).success).toBe(false);
  });

  test("成功外框固定為 ok、summary、data", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { status: "review" });
      const result = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });

      expect(result.ok).toBe(true);
      expect(Object.keys(result).sort()).toEqual(["data", "ok", "summary"]);
    });
  });
});

describe("work_review 的審查規則", () => {
  test("owner 不能 approve 自己的項目", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { owner: "build", status: "review" });
      const explicit = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "build",
        note: "我自己看過了",
      });

      expect(explicit.ok).toBe(false);
      if (explicit.ok) return;
      expect(explicit.code).toBe("REVIEWER_IS_OWNER");
      expect(readWork(db, workId)?.review).toBeNull();

      const implicit = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "approve",
      });
      expect(implicit.ok).toBe(false);
      if (implicit.ok) return;
      expect(implicit.code).toBe("REVIEWER_IS_OWNER");
    });
  });

  test("owner 可以記錄 concerns 與 reject，但不能當作通過", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { owner: "build", status: "review" });
      const concerns = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "concerns",
        note: "補一個邊際情況",
      });

      expect(concerns.ok).toBe(true);
      if (!concerns.ok) return;
      expect(concerns.data).toMatchObject({ verdict: "concerns", reviewer: "build" });
      expect(readWork(db, workId)?.review).toContain("concerns");

      const rejected = await callReview(context, {
        id: workId,
        expectedVersion: 2,
        verdict: "reject",
        note: "缺一個邊際情況的測試",
      });
      expect(rejected.ok).toBe(true);
      expect(readWork(db, workId)?.review).toContain("reject");
    });
  });

  test("記錄 verdict、note、reviewer 與審查版本，並把工作推進到 review", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { status: "review", version: 4 });
      const result = await callReview(context, {
        id: workId,
        expectedVersion: 4,
        verdict: "approve",
        reviewer: "momus",
        note: "看過 diff 與測試",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toMatchObject({
        workId,
        status: "review",
        verdict: "approve",
        reviewer: "momus",
        note: "看過 diff 與測試",
        reviewedVersion: 5,
        version: 5,
      });

      const row = readWork(db, workId);
      expect(row?.status).toBe("review");
      expect(row?.version).toBe(5);
      expect(row?.reviewed_version).toBe(5);
      const review = JSON.parse(row?.review ?? "null") as {
        verdict: string;
        reviewer: string;
        note?: string;
        reviewedAt?: string;
        reviewedVersion?: number;
      };
      expect(review.verdict).toBe("approve");
      expect(review.reviewer).toBe("momus");
      expect(review.note).toBe("看過 diff 與測試");
      expect(review.reviewedVersion).toBe(5);
      expect(typeof review.reviewedAt).toBe("string");
    });
  });

  test("in_progress 可以記錄審查並推進到 review", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { status: "in_progress", version: 1 });
      const result = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toMatchObject({ status: "review", version: 2, reviewedVersion: 2 });
      expect(readWork(db, workId)?.status).toBe("review");
    });
  });

  test("沒有指定 reviewer 時使用目前 actor", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { owner: "momus", status: "review" });
      const result = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "approve",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.data as { reviewer: string }).reviewer).toBe("build");
    });
  });

  test("審查後版本變動會讓舊 approve 失效", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const workId = insertWork(db, projectId, { risk: "high", status: "review", acceptance: ["a"] });
      const evidenceId = insertEvidence(db, projectId, workId, { serverIssued: true });

      const review = await callReview(context, {
        id: workId,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(review.ok).toBe(true);

      db.query("UPDATE work_items SET version = 3, updated_at = ? WHERE work_id = ?").run(
        new Date().toISOString(),
        workId,
      );

      const stale = await callComplete(context, {
        id: workId,
        expectedVersion: 3,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [evidenceId] }],
      });

      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.code).toBe("REVIEW_STALE");
      expect(stale.data).toMatchObject({ reviewedVersion: 2, currentVersion: 3 });

      const again = await callReview(context, {
        id: workId,
        expectedVersion: 3,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(again.ok).toBe(true);

      const passed = await callComplete(context, {
        id: workId,
        expectedVersion: 4,
        acceptance: [{ criterion: "a", met: true, evidenceIds: [evidenceId] }],
      });
      expect(passed.ok).toBe(true);
    });
  });

  test("非法狀態不能記錄審查", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const open = insertWork(db, projectId, { status: "open" });
      const fromOpen = await callReview(context, {
        id: open,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(fromOpen.ok).toBe(false);
      if (fromOpen.ok) return;
      expect(fromOpen.code).toBe("INVALID_TRANSITION");

      const blocked = insertWork(db, projectId, { status: "blocked" });
      const fromBlocked = await callReview(context, {
        id: blocked,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(fromBlocked.ok).toBe(false);
      if (fromBlocked.ok) return;
      expect(fromBlocked.code).toBe("INVALID_TRANSITION");

      const done = insertWork(db, projectId, { status: "done", resolution: "completed" });
      const fromDone = await callReview(context, {
        id: done,
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(fromDone.ok).toBe(false);
      if (fromDone.ok) return;
      expect(fromDone.code).toBe("INVALID_TRANSITION");
    });
  });

  test("找不到工作或版本不符時拒絕審查", async () => {
    await withLifecycle(async ({ db, projectId, context }) => {
      const missing = await callReview(context, {
        id: "work-does-not-exist",
        expectedVersion: 1,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.code).toBe("WORK_NOT_FOUND");

      const workId = insertWork(db, projectId, { status: "review", version: 5 });
      const conflict = await callReview(context, {
        id: workId,
        expectedVersion: 2,
        verdict: "approve",
        reviewer: "momus",
      });
      expect(conflict.ok).toBe(false);
      if (conflict.ok) return;
      expect(conflict.code).toBe("VERSION_CONFLICT");
      expect(conflict.data.currentVersion).toBe(5);
    });
  });
});
