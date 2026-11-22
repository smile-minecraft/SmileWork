import { describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "../helpers/temp.ts";
import {
  callTool,
  callToolOk,
  createScriptFixtureProject,
  e2eEnvironment,
  startE2eServer,
  startRawStdioSession,
  type RawFrame,
  type RunningServer,
} from "./helpers.ts";
import type { ToolResult } from "../../src/shared/result.ts";

interface WorkRef {
  id: string;
  version: number;
  status: string;
  owner: string;
}

interface EvidenceRef {
  evidenceId: string;
  outputPath: string;
  serverIssued: boolean;
}

interface HygieneFinding {
  rule: string;
  path: string;
  line: number;
  snippet: string;
}

const ACCEPTANCE = ["src workflow updated", "verification passes"];

function workOf(data: Record<string, unknown>): WorkRef {
  return data.work as WorkRef;
}

function failureCode(result: ToolResult, expected: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(expected);
}

async function verify(winner: RunningServer, workId: string): Promise<ToolResult> {
  return callTool(winner.client, "verify_run", { workId, runner: "script", script: "verify" });
}

async function submitForReview(winner: RunningServer, workId: string): Promise<ToolResult> {
  return callTool(winner.client, "work_update", { id: workId, expectedVersion: 2, status: "review" });
}

describe("MCP 多進程黑箱端對端", () => {
  test("三個獨立 stdio 進程走完高風險硬閘門流程", async () => {
    await withTempDir("e2e-multi-client-workflow", async (root) => {
      const home = join(root, "home", ".smilework");
      const fixture = await createScriptFixtureProject(root);
      const workerA = await startE2eServer(
        e2eEnvironment(home, fixture.repo, { profile: "full", actor: "worker-a" }),
      );
      const workerB = await startE2eServer(
        e2eEnvironment(home, fixture.repo, { profile: "full", actor: "worker-b" }),
      );
      const reviewer = await startE2eServer(
        e2eEnvironment(home, fixture.repo, { profile: "full", actor: "reviewer-c" }),
      );

      try {
        const created = await callToolOk(workerA.client, "work_create", {
          title: "multi-process hard gate",
          objective: "Exercise every hard gate across three independent MCP stdio processes.",
          acceptance: ACCEPTANCE,
          risk: "high",
          scopePaths: ["src/"],
        });
        const work = workOf(created);
        expect(work).toMatchObject({ status: "open", version: 1 });

        // 兩個 worker 同時認領：只能有一個成功，另一個拿到 VERSION_CONFLICT。
        const [claimA, claimB] = await Promise.all([
          callTool(workerA.client, "work_update", {
            id: work.id,
            expectedVersion: 1,
            status: "in_progress",
          }),
          callTool(workerB.client, "work_update", {
            id: work.id,
            expectedVersion: 1,
            status: "in_progress",
          }),
        ]);
        const claims = [claimA, claimB];
        expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
        expect(claims.filter((claim) => !claim.ok)).toHaveLength(1);
        failureCode(claims.find((claim) => !claim.ok)!, "VERSION_CONFLICT");

        const winnerIndex = claimA.ok ? 0 : 1;
        const winner = [workerA, workerB][winnerIndex]!;
        const loser = [workerA, workerB][1 - winnerIndex]!;
        const owner = winnerIndex === 0 ? "worker-a" : "worker-b";
        const claimed = claims[winnerIndex]!;
        expect(workOf(claimed.data as Record<string, unknown>)).toMatchObject({
          status: "in_progress",
          version: 2,
          owner,
        });

        // 落敗者重新讀到版本 2，仍然不能越過認領保護修改工作。
        const reread = await callToolOk(loser.client, "work_get", { id: work.id });
        expect(workOf(reread)).toMatchObject({ status: "in_progress", version: 2, owner });
        failureCode(
          await callTool(loser.client, "work_update", {
            id: work.id,
            expectedVersion: 2,
            title: "unauthorized edit",
          }),
          "WORK_ALREADY_CLAIMED",
        );

        // 失敗的 verify_run：完整輸出留在 outputPath，回應保持精簡。
        await writeFile(fixture.source, 'test("broken", () => { expect(1).toBe(2); });\n', "utf8");
        const failedResult = await verify(winner, work.id);
        expect(failedResult.ok).toBe(true);
        const failed = failedResult.data as Record<string, unknown>;
        expect(failed).toMatchObject({ passed: false, exitCode: 1, responseTruncated: true });
        const outputPath = String(failed.outputPath);
        expect(existsSync(outputPath)).toBe(true);
        expect(readFileSync(outputPath, "utf8").length).toBeGreaterThan(20_000);
        expect(String(failed.outputTail).length).toBeGreaterThan(0);
        const highlights = failed.errorHighlights as string[];
        expect(highlights.some((line) => line.includes("FAIL"))).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(failedResult), "utf8")).toBeLessThan(16_384);

        const failedGate = await submitForReview(winner, work.id);
        failureCode(failedGate, "SERVER_EVIDENCE_FAILED");
        if (!failedGate.ok) {
          expect((failedGate.data.latestFailed as { outputPath: string }).outputPath).toBe(outputPath);
        }

        // 讓腳本通過，但注入 @ts-ignore 企圖繞過 diff 衛生。
        await writeFile(fixture.marker, "passing\n", "utf8");
        await writeFile(fixture.source, "// @ts-ignore\nexport const workflow = \"cheat\";\n", "utf8");
        expect((await verify(winner, work.id)).data).toMatchObject({ passed: true });
        const hygieneGate = await submitForReview(winner, work.id);
        failureCode(hygieneGate, "DIFF_HYGIENE_FAILED");
        if (!hygieneGate.ok) {
          const finding = (hygieneGate.data.findings as HygieneFinding[])[0]!;
          expect(finding).toMatchObject({ rule: "ts-ignore", path: "src/workflow.ts" });
          expect(finding.line).toBeGreaterThan(0);
        }

        // 清掉繞過寫法，但動到 scope 外的檔案。
        await writeFile(fixture.source, 'export const workflow = "clean";\n', "utf8");
        await writeFile(fixture.outside, "out of scope\n", "utf8");
        expect((await verify(winner, work.id)).data).toMatchObject({ passed: true });
        const scopeGate = await submitForReview(winner, work.id);
        failureCode(scopeGate, "SCOPE_VIOLATION");
        if (!scopeGate.ok) {
          expect(scopeGate.data.scopeViolations).toContain("outside.txt");
        }

        // 清乾淨後取得新鮮證據，再動 src/ 讓證據過期。
        rmSync(fixture.outside);
        await writeFile(fixture.source, 'export const workflow = "fixed";\n', "utf8");
        expect((await verify(winner, work.id)).data).toMatchObject({ passed: true });
        await writeFile(join(fixture.repo, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
        failureCode(await submitForReview(winner, work.id), "SERVER_EVIDENCE_STALE");

        // 重跑驗證後才能送審。
        const finalResult = await verify(winner, work.id);
        expect(finalResult.data).toMatchObject({ passed: true });
        const finalEvidence = (finalResult.data as Record<string, unknown>).evidence as EvidenceRef;
        const submitted = await callToolOk(winner.client, "work_update", {
          id: work.id,
          expectedVersion: 2,
          status: "review",
        });
        expect(workOf(submitted)).toMatchObject({ status: "review", version: 3, owner });

        // owner 用 reviewer 欄位冒充獨立審查者仍然被擋下。
        failureCode(
          await callTool(winner.client, "work_review", {
            id: work.id,
            expectedVersion: 3,
            verdict: "approve",
            reviewer: "reviewer-c",
          }),
          "REVIEWER_IS_OWNER",
        );

        // 真正的第二個進程讀取完整證據、核准並結案。
        const inspected = await callToolOk(reviewer.client, "work_get", { id: work.id });
        expect(workOf(inspected)).toMatchObject({ status: "review", version: 3, owner });
        const evidenceList = inspected.evidence as EvidenceRef[];
        expect(evidenceList.length).toBeGreaterThanOrEqual(5);
        expect(evidenceList.map((item) => item.evidenceId)).toContain(finalEvidence.evidenceId);
        const approved = await callToolOk(reviewer.client, "work_review", {
          id: work.id,
          expectedVersion: 3,
          verdict: "approve",
          note: "Independent cross-process review.",
        });
        expect(approved).toMatchObject({ status: "review", version: 4 });
        const completed = await callToolOk(reviewer.client, "work_complete", {
          id: work.id,
          expectedVersion: 4,
          acceptance: ACCEPTANCE.map((criterion) => ({
            criterion,
            met: true,
            evidenceIds: [finalEvidence.evidenceId],
          })),
        });
        expect(completed).toMatchObject({ status: "done", resolution: "completed", version: 5 });
      } finally {
        await reviewer.close();
        await workerB.close();
        await workerA.close();
      }
    });
  }, 120_000);

  test("三個 stdio 進程並行讀寫共用資料庫時沒有任何錯誤", async () => {
    await withTempDir("e2e-multi-client-load", async (root) => {
      const home = join(root, "home", ".smilework");
      const repo = await createScriptFixtureProject(root);
      const servers = await Promise.all(
        ["worker-a", "worker-b", "reviewer-c"].map((actor) =>
          startE2eServer(e2eEnvironment(home, repo.repo, { profile: "full", actor })),
        ),
      );

      try {
        const seed = workOf(await callToolOk(servers[0]!.client, "work_create", {
          title: "load seed",
          acceptance: ["seed"],
          risk: "low",
        }));

        const calls: Array<Promise<ToolResult>> = [];
        for (const server of servers) {
          calls.push(callTool(server.client, "work_get", { id: seed.id }));
          calls.push(callTool(server.client, "work_list", {}));
          calls.push(callTool(server.client, "status", {}));
          calls.push(callTool(server.client, "work_create", {
            title: `load work ${seed.id}`,
            acceptance: ["ok"],
            risk: "low",
          }));
          calls.push(callTool(server.client, "signal_note", {
            kind: "lesson",
            content: `load note ${seed.id}`,
            scope: "project",
          }));
        }

        const outcomes = await Promise.all(
          calls.map(async (call) => {
            try {
              const result = await call;
              return { ok: result.ok, code: result.ok ? null : result.code, error: null };
            } catch (error) {
              return { ok: false, code: "TRANSPORT_ERROR", error: String(error) };
            }
          }),
        );
        const failures = outcomes.filter((outcome) => !outcome.ok);
        expect(failures).toEqual([]);
        expect(outcomes).toHaveLength(15);
      } finally {
        await Promise.all(servers.map((server) => server.close()));
      }
    });
  }, 120_000);

  test("原始 stdout 的每一行都是合法的 JSON-RPC 2.0 frame", async () => {
    await withTempDir("e2e-raw-jsonrpc", async (root) => {
      const home = join(root, "home", ".smilework");
      const fixture = await createScriptFixtureProject(root);
      const session = await startRawStdioSession(
        e2eEnvironment(home, fixture.repo, { profile: "full", actor: "raw-probe" }),
      );

      try {
        await session.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "raw-frame-probe", version: "0.0.0" },
          },
        });
        const initialized = await session.waitForResponse(1);
        expect(initialized.jsonrpc).toBe("2.0");
        expect((initialized.result as Record<string, unknown>).protocolVersion).toBe(
          LATEST_PROTOCOL_VERSION,
        );

        await session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

        await session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const listed = await session.waitForResponse(2);
        const tools = (listed.result as { tools: unknown[] }).tools;
        expect(tools.length).toBeGreaterThan(0);

        await session.send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "status", arguments: {} },
        });
        const called = await session.waitForResponse(3);
        const content = (called.result as { content: unknown[] }).content;
        expect(content.length).toBeGreaterThan(0);

        expect(await session.close()).toBe(0);
        const lines = session.lines().filter((line) => line.trim().length > 0);
        expect(lines.length).toBeGreaterThanOrEqual(3);
        const ids = new Set<number>();
        for (const line of lines) {
          const frame = JSON.parse(line) as RawFrame;
          expect(frame.jsonrpc).toBe("2.0");
          expect(Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")).toBe(true);
          if (typeof frame.id === "number") ids.add(frame.id);
        }
        expect([...ids].sort()).toEqual([1, 2, 3]);
      } finally {
        await session.close();
      }
    });
  }, 60_000);
});
