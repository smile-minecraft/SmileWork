import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { openDatabase } from "../../src/db/index.ts";
import type { Signal } from "../../src/domain/signal.ts";
import { SIGNAL_KINDS } from "../../src/domain/signal.ts";
import { defineTool } from "../../src/mcp/define-tool.ts";
import { runTool } from "../../src/mcp/result.ts";
import type { ToolDefinition } from "../../src/mcp/types.ts";
import { fail, ok, type ToolResult, type ToolSuccess } from "../../src/shared/result.ts";
import { tool as signalList } from "../../src/tools/signal/list.ts";
import { tool as signalMark } from "../../src/tools/signal/mark.ts";
import { tool as signalNote } from "../../src/tools/signal/note.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempHome } from "../helpers/temp.ts";

interface Fixture {
  home: string;
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

async function withSignalFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempHome("signal", async (home, root) => {
    const repo = await createGitRepo(join(root, "repo"));
    await run({
      home,
      root,
      repo,
      env: {
        ...process.env,
        SMILEWORK_HOME: home,
        SMILEWORK_PROJECT: repo,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      },
    });
  });
}

async function callWith(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ToolResult> {
  const result = await runTool(tool, input, { env, cwd });
  const block = result.content[0];
  const text = block?.type === "text" ? block.text : "";
  return JSON.parse(text) as ToolResult;
}

async function call(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  fixture: Fixture,
): Promise<ToolResult> {
  return callWith(tool, input, fixture.env, fixture.repo);
}

function dataOf<T>(result: ToolResult): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return (result as ToolSuccess<T>).data;
}

function signalOf(result: ToolResult): Signal {
  return dataOf<{ signal: Signal }>(result).signal;
}

function listOf(result: ToolResult): { signals: Signal[]; total: number; hasMore: boolean } {
  return dataOf(result);
}

function withDb<T>(home: string, run: (db: Database) => T): T {
  const db = openDatabase({ home });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function countSignals(home: string): number {
  return withDb(home, (db) =>
    (db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM signals").get()?.count ?? 0),
  );
}

function backdate(home: string, signalId: string, createdAt: string, updatedAt: string): void {
  withDb(home, (db) => {
    db.query("UPDATE signals SET created_at = ?, updated_at = ? WHERE signal_id = ?").run(
      createdAt,
      updatedAt,
      signalId,
    );
  });
}

describe("signal_note", () => {
  test("六種 kind 都能建立，list 可依 kind 與 status 篩選", async () => {
    await withSignalFixture(async (fixture) => {
      expect(SIGNAL_KINDS).toEqual([
        "correction",
        "failure",
        "fix",
        "review-reject",
        "lesson",
        "other",
      ]);

      for (const kind of SIGNAL_KINDS) {
        const signal = signalOf(
          await call(signalNote, { kind, content: `訊號內容：${kind}` }, fixture),
        );
        expect(signal.kind).toBe(kind);
        expect(signal.status).toBe("new");
        expect(signal.actor).toBe("build");
        expect(signal.actorModel).toBe("test-model");
      }

      for (const kind of SIGNAL_KINDS) {
        const listed = listOf(await call(signalList, { kind }, fixture));
        expect(listed.total).toBe(1);
        expect(listed.signals[0]?.kind).toBe(kind);
      }

      const fresh = listOf(await call(signalList, { status: "new" }, fixture));
      expect(fresh.total).toBe(SIGNAL_KINDS.length);

      const dismissed = listOf(await call(signalList, { status: "dismissed" }, fixture));
      expect(dismissed.total).toBe(0);
    });
  });

  test("content 超過 1000 字元會被拒絕，且不寫入資料", async () => {
    await withSignalFixture(async (fixture) => {
      const result = await call(
        signalNote,
        { kind: "lesson", content: "字".repeat(1001) },
        fixture,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("VALIDATION_ERROR");
        expect(result.data).toMatchObject({ field: "content", limit: 1000 });
      }
      expect(countSignals(fixture.home)).toBe(0);

      const boundary = signalOf(
        await call(signalNote, { kind: "lesson", content: "字".repeat(1000) }, fixture),
      );
      expect(boundary.content).toHaveLength(1000);
      expect(countSignals(fixture.home)).toBe(1);
    });
  });

  test("不合法的 kind 與舊名稱會被拒絕並列出允許值", async () => {
    await withSignalFixture(async (fixture) => {
      for (const kind of ["bogus", "review_reject", "decision"]) {
        const result = await call(signalNote, { kind, content: "內容" }, fixture);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("VALIDATION_ERROR");
          expect(result.data).toMatchObject({ field: "kind" });
          expect(result.data.allowedKinds).toEqual([...SIGNAL_KINDS]);
        }
      }
      expect(countSignals(fixture.home)).toBe(0);
    });
  });

  test("workItemId 與 refs 會保存到訊號", async () => {
    await withSignalFixture(async (fixture) => {
      const signal = signalOf(
        await call(
          signalNote,
          {
            kind: "correction",
            content: "使用者糾正了回報方式",
            workItemId: "work-1",
            refs: ["file:src/a.ts", "issue:42"],
          },
          fixture,
        ),
      );

      expect(signal.workId).toBe("work-1");
      expect(signal.refs).toEqual(["file:src/a.ts", "issue:42"]);
      expect(signal.projectId).not.toBeNull();

      const row = withDb(fixture.home, (db) =>
        db
          .query<{ work_id: string; refs: string }, [string]>(
            "SELECT work_id, refs FROM signals WHERE signal_id = ?",
          )
          .get(signal.signalId),
      );
      expect(row?.work_id).toBe("work-1");
      expect(JSON.parse(row?.refs ?? "[]")).toEqual(["file:src/a.ts", "issue:42"]);
    });
  });

  test("同一個 idempotencyKey 重送只產生一筆，不同內容則回衝突", async () => {
    await withSignalFixture(async (fixture) => {
      const input = { kind: "fix", content: "修好了", idempotencyKey: "idem-1" };
      const first = signalOf(await call(signalNote, input, fixture));
      const second = signalOf(await call(signalNote, input, fixture));

      expect(second.signalId).toBe(first.signalId);
      expect(countSignals(fixture.home)).toBe(1);

      const keys = withDb(fixture.home, (db) =>
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM idempotency_keys WHERE tool = 'signal_note' AND key = 'idem-1'",
          )
          .get()?.count,
      );
      expect(keys).toBe(1);

      const conflict = await call(
        signalNote,
        { ...input, content: "同一個鍵但內容不同" },
        fixture,
      );
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(countSignals(fixture.home)).toBe(1);
    });
  });

  test("project 範圍無法解析專案時回 PROJECT_UNRESOLVED，global 範圍不需要專案", async () => {
    await withSignalFixture(async (fixture) => {
      const env = { SMILEWORK_HOME: fixture.home, SMILEWORK_ACTOR: "build" };

      const projectless = await callWith(
        signalNote,
        { kind: "lesson", content: "沒有專案" },
        { ...env, SMILEWORK_PROJECT: join(fixture.root, "missing") },
        fixture.root,
      );
      expect(projectless.ok).toBe(false);
      if (!projectless.ok) expect(projectless.code).toBe("PROJECT_UNRESOLVED");

      const global = await callWith(
        signalNote,
        { kind: "lesson", content: "全域訊號", scope: "global" },
        env,
        fixture.root,
      );
      const signal = signalOf(global);
      expect(signal.scope).toBe("global");
      expect(signal.projectId).toBeNull();
    });
  });
});

describe("signal_mark", () => {
  test("把多筆訊號標成 consumed 或 dismissed，並保存 reason 與 resultRefs", async () => {
    await withSignalFixture(async (fixture) => {
      const first = signalOf(await call(signalNote, { kind: "failure", content: "失敗一" }, fixture));
      const second = signalOf(await call(signalNote, { kind: "failure", content: "失敗二" }, fixture));

      const marked = dataOf<{ signals: Signal[] }>(
        await call(
          signalMark,
          {
            ids: [first.signalId, second.signalId],
            status: "consumed",
            reason: "整理完成",
            resultRefs: ["knowledge:k-1"],
          },
          fixture,
        ),
      );

      expect(marked.signals).toHaveLength(2);
      for (const signal of marked.signals) {
        expect(signal.status).toBe("consumed");
        expect(signal.reason).toBe("整理完成");
        expect(signal.resultRefs).toEqual(["knowledge:k-1"]);
        expect(signal.updatedBy).toBe("build");
      }

      const consumed = listOf(await call(signalList, { status: "consumed" }, fixture));
      expect(consumed.total).toBe(2);

      const row = withDb(fixture.home, (db) =>
        db
          .query<{ status: string; reason: string; result_refs: string }, [string]>(
            "SELECT status, reason, result_refs FROM signals WHERE signal_id = ?",
          )
          .get(first.signalId),
      );
      // 資料庫的 status CHECK 仍使用舊值，store 對外一律轉成新名稱。
      expect(row?.status).toBe("accepted");
      expect(row?.reason).toBe("整理完成");
      expect(JSON.parse(row?.result_refs ?? "[]")).toEqual(["knowledge:k-1"]);

      const dismissed = dataOf<{ signals: Signal[] }>(
        await call(signalMark, { ids: [first.signalId], status: "dismissed" }, fixture),
      );
      expect(dismissed.signals[0]?.status).toBe("dismissed");
      expect(dismissed.signals[0]?.reason).toBe("整理完成");
      expect(dismissed.signals[0]?.resultRefs).toEqual(["knowledge:k-1"]);
    });
  });

  test("標記狀態不改原始內容與建立時間", async () => {
    await withSignalFixture(async (fixture) => {
      const before = signalOf(
        await call(
          signalNote,
          { kind: "review-reject", content: "審查退回：缺測試", refs: ["review:r-1"] },
          fixture,
        ),
      );
      backdate(
        fixture.home,
        before.signalId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      const after = dataOf<{ signals: Signal[] }>(
        await call(
          signalMark,
          {
            ids: [before.signalId],
            status: "consumed",
            reason: "已建立對應工作",
            resultRefs: ["work:work-2"],
          },
          fixture,
        ),
      ).signals[0]!;

      expect(after.content).toBe(before.content);
      expect(after.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(after.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
      expect(after.kind).toBe(before.kind);
      expect(after.refs).toEqual(before.refs);

      const row = withDb(fixture.home, (db) =>
        db
          .query<{ content: string; created_at: string }, [string]>(
            "SELECT content, created_at FROM signals WHERE signal_id = ?",
          )
          .get(before.signalId),
      );
      expect(row?.content).toBe(before.content);
      expect(row?.created_at).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  test("不合法的 status 與舊名稱回 INVALID_STATUS 並列出允許值", async () => {
    await withSignalFixture(async (fixture) => {
      const signal = signalOf(await call(signalNote, { kind: "lesson", content: "內容" }, fixture));

      for (const status of ["accepted", "triaged", "open"]) {
        const result = await call(
          signalMark,
          { ids: [signal.signalId], status },
          fixture,
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("INVALID_STATUS");
          expect(result.data).toMatchObject({ field: "status" });
          expect(result.data.allowedStatuses).toEqual(["new", "consumed", "dismissed"]);
        }
      }

      const unchanged = listOf(await call(signalList, { status: "new" }, fixture));
      expect(unchanged.total).toBe(1);
      expect(unchanged.signals[0]?.status).toBe("new");
    });
  });

  test("有 id 不存在時整批不更新並回 SIGNAL_NOT_FOUND", async () => {
    await withSignalFixture(async (fixture) => {
      const signal = signalOf(await call(signalNote, { kind: "lesson", content: "內容" }, fixture));

      const result = await call(
        signalMark,
        { ids: [signal.signalId, "sig-missing"], status: "dismissed" },
        fixture,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("SIGNAL_NOT_FOUND");
        expect(result.data.missingIds).toEqual(["sig-missing"]);
      }

      const fresh = listOf(await call(signalList, { status: "new" }, fixture));
      expect(fresh.total).toBe(1);
      expect(fresh.signals[0]?.status).toBe("new");
    });
  });
});

describe("signal_list", () => {
  test("支援 since、分頁與穩定排序", async () => {
    await withSignalFixture(async (fixture) => {
      const first = signalOf(await call(signalNote, { kind: "lesson", content: "第一筆" }, fixture));
      const second = signalOf(await call(signalNote, { kind: "lesson", content: "第二筆" }, fixture));
      const third = signalOf(await call(signalNote, { kind: "lesson", content: "第三筆" }, fixture));

      backdate(fixture.home, first.signalId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      backdate(fixture.home, second.signalId, "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:01.000Z");
      backdate(fixture.home, third.signalId, "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:02.000Z");

      const page1 = listOf(await call(signalList, { limit: 2, offset: 0 }, fixture));
      expect(page1.total).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.signals.map((signal) => signal.signalId)).toEqual([third.signalId, second.signalId]);

      const page2 = listOf(await call(signalList, { limit: 2, offset: 2 }, fixture));
      expect(page2.hasMore).toBe(false);
      expect(page2.signals.map((signal) => signal.signalId)).toEqual([first.signalId]);

      const since = listOf(
        await call(signalList, { since: "2026-01-01T00:00:01.000Z" }, fixture),
      );
      expect(since.total).toBe(2);
      expect(since.signals.map((signal) => signal.signalId)).toEqual([third.signalId, second.signalId]);
    });
  });

  test("舊資料的 kind 與 status 會轉成新名稱", async () => {
    await withSignalFixture(async (fixture) => {
      const base = signalOf(await call(signalNote, { kind: "lesson", content: "基準" }, fixture));
      const projectId = base.projectId!;
      const createdAt = "2026-01-01T00:00:00.000Z";

      withDb(fixture.home, (db) => {
        const insert = db.query(
          `INSERT INTO signals (
             signal_id, project_id, scope, kind, content, status, work_id,
             refs, result_refs, reason, actor, actor_model, created_at, updated_at, updated_by
           ) VALUES (?, ?, 'project', ?, ?, ?, NULL, '[]', '[]', NULL, 'legacy', 'm', ?, ?, NULL)`,
        );
        insert.run("sig-legacy-review", projectId, "review_reject", "舊審查退回", "triaged", createdAt, createdAt);
        insert.run("sig-legacy-decision", projectId, "decision", "舊決定", "accepted", createdAt, createdAt);
      });

      const reviewReject = listOf(await call(signalList, { kind: "review-reject" }, fixture));
      expect(reviewReject.total).toBe(1);
      expect(reviewReject.signals[0]).toMatchObject({
        signalId: "sig-legacy-review",
        kind: "review-reject",
        status: "new",
      });

      const other = listOf(await call(signalList, { kind: "other" }, fixture));
      expect(other.total).toBe(1);
      expect(other.signals[0]).toMatchObject({
        signalId: "sig-legacy-decision",
        kind: "other",
        status: "consumed",
      });

      const fresh = listOf(await call(signalList, { status: "new" }, fixture));
      expect(fresh.total).toBe(2);
      const consumed = listOf(await call(signalList, { status: "consumed" }, fixture));
      expect(consumed.total).toBe(1);
    });
  });

  test("scope 可列出專案、全域或兩者", async () => {
    await withSignalFixture(async (fixture) => {
      const projectSignal = signalOf(
        await call(signalNote, { kind: "lesson", content: "專案訊號" }, fixture),
      );
      const globalSignal = signalOf(
        await call(signalNote, { kind: "lesson", content: "全域訊號", scope: "global" }, fixture),
      );

      const project = listOf(await call(signalList, { scope: "project" }, fixture));
      expect(project.signals.map((signal) => signal.signalId)).toEqual([projectSignal.signalId]);

      const global = listOf(await call(signalList, { scope: "global" }, fixture));
      expect(global.signals.map((signal) => signal.signalId)).toEqual([globalSignal.signalId]);

      const all = listOf(await call(signalList, { scope: "all" }, fixture));
      expect(all.total).toBe(2);
    });
  });
});

describe("工具輸入驗證模式", () => {
  test("只有標記 handler 驗證的工具會跳過 generic 驗證", async () => {
    const schema = z.object({ count: z.number() });
    const generic = defineTool({
      name: "probe_generic",
      title: "一般驗證",
      description: "測試用",
      domain: "signal",
      inputSchema: schema,
      handler: () => ok("到 handler", { reached: true }),
    });
    const custom = defineTool({
      name: "probe_custom",
      title: "自訂驗證",
      description: "測試用",
      domain: "signal",
      validation: "handler",
      inputSchema: schema,
      handler: () => fail("CUSTOM_ERROR", "由 handler 回報", "修正後重試。"),
    });

    const genericResult = await callWith(generic, { count: "bad" }, {}, process.cwd());
    expect(genericResult.ok).toBe(false);
    if (!genericResult.ok) {
      expect(genericResult.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(genericResult.data.issues)).toBe(true);
    }

    const customResult = await callWith(custom, { count: "bad" }, {}, process.cwd());
    expect(customResult.ok).toBe(false);
    if (!customResult.ok) expect(customResult.code).toBe("CUSTOM_ERROR");
  });
});
