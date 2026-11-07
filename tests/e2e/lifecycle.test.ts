import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../helpers/temp.ts";
import {
  callTool,
  callToolOk,
  createE2eProject,
  e2eEnvironment,
  startE2eServer,
} from "./helpers.ts";

interface WorkReference {
  id: string;
  version: number;
  status: string;
}

interface EvidenceReference {
  evidenceId: string;
  serverIssued: boolean;
  outputPath: string;
}

function workOf(data: Record<string, unknown>): WorkReference {
  return data.work as WorkReference;
}

describe("MCP 端對端：建立、驗證、審查、結案", () => {
  test("高風險工作跑完一輪，缺少核准時結案被擋下", async () => {
    await withTempDir("e2e-lifecycle", async (root) => {
      const home = join(root, "home", ".smilework");
      const project = await createE2eProject(root);
      await project.create({ passing: true });
      const server = await startE2eServer(
        e2eEnvironment(home, project.repo, { profile: "full", actor: "e2e-owner" }),
      );

      try {
        const created = await callToolOk(server.client, "work_create", {
          title: "端對端高風險流程",
          objective: "用真實的 verify_run 取得伺服器證據，再完成審查與結案。",
          acceptance: ["verify_run 通過", "獨立審查完成"],
          risk: "high",
        });
        const work = workOf(created);
        expect(work).toMatchObject({ status: "open", version: 1 });

        const started = await callToolOk(server.client, "work_update", {
          id: work.id,
          expectedVersion: 1,
          status: "in_progress",
        });
        expect(workOf(started)).toMatchObject({ status: "in_progress", version: 2 });

        const verified = await callToolOk(server.client, "verify_run", {
          workId: work.id,
          runner: "bun",
          script: "test",
        });
        expect(verified.passed).toBe(true);
        expect(verified.serverIssued).toBe(true);
        const evidence = verified.evidence as EvidenceReference;
        expect(evidence.serverIssued).toBe(true);
        expect(evidence.evidenceId).toStartWith("evidence-");
        expect(existsSync(evidence.outputPath)).toBe(true);

        const concerns = await callToolOk(server.client, "work_review", {
          id: work.id,
          expectedVersion: 2,
          verdict: "concerns",
          reviewer: "independent-reviewer",
          note: "先確認高風險核准。",
        });
        expect(concerns).toMatchObject({ status: "review", version: 3 });

        const blocked = await callTool(server.client, "work_complete", {
          id: work.id,
          expectedVersion: 3,
          acceptance: [
            { criterion: "verify_run 通過", met: true, evidenceIds: [evidence.evidenceId] },
            { criterion: "獨立審查完成", met: true, evidenceIds: [evidence.evidenceId] },
          ],
        });
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) {
          expect(blocked.code).toBe("REVIEW_REQUIRED");
          expect(blocked.data.blockedBy).toContain("REVIEW_REQUIRED");
        }

        const approved = await callToolOk(server.client, "work_review", {
          id: work.id,
          expectedVersion: 3,
          verdict: "approve",
          reviewer: "independent-reviewer",
          note: "證據可重現，核准結案。",
        });
        expect(approved).toMatchObject({ status: "review", version: 4 });

        const completed = await callToolOk(server.client, "work_complete", {
          id: work.id,
          expectedVersion: 4,
          acceptance: [
            { criterion: "verify_run 通過", met: true, evidenceIds: [evidence.evidenceId] },
            { criterion: "獨立審查完成", met: true, evidenceIds: [evidence.evidenceId] },
          ],
          note: "端對端流程完成。",
        });
        expect(completed).toMatchObject({
          status: "done",
          resolution: "completed",
          version: 5,
        });

        const fetched = await callToolOk(server.client, "work_get", { id: work.id });
        expect(fetched.work).toMatchObject({
          status: "done",
          resolution: "completed",
          version: 5,
          review: {
            verdict: "approve",
            reviewer: "independent-reviewer",
            reviewedVersion: 4,
          },
        });
        const acceptanceResults = (fetched.work as Record<string, unknown>)
          .acceptanceResults as { items: Array<{ criterion: string; met: boolean }> };
        expect(acceptanceResults.items).toHaveLength(2);
        expect(acceptanceResults.items.every((item) => item.met)).toBe(true);

        const fetchedEvidence = fetched.evidence as EvidenceReference[];
        expect(fetchedEvidence).toHaveLength(1);
        expect(fetchedEvidence[0]).toMatchObject({
          evidenceId: evidence.evidenceId,
          serverIssued: true,
        });
      } finally {
        await server.close();
      }
    });
  }, 60_000);

  test("缺少驗收結果、證據或高風險核准時，結案失敗且狀態不變", async () => {
    await withTempDir("e2e-gates", async (root) => {
      const home = join(root, "home", ".smilework");
      const project = await createE2eProject(root);
      await project.create({ passing: true });
      const server = await startE2eServer(
        e2eEnvironment(home, project.repo, { profile: "full", actor: "e2e-owner" }),
      );

      try {
        const missingAcceptance = workOf(
          await callToolOk(server.client, "work_create", {
            title: "缺少驗收結果",
            acceptance: ["項目 A"],
            risk: "low",
          }),
        );
        await callToolOk(server.client, "work_update", {
          id: missingAcceptance.id,
          expectedVersion: 1,
          status: "in_progress",
        });
        await callToolOk(server.client, "work_review", {
          id: missingAcceptance.id,
          expectedVersion: 2,
          verdict: "approve",
          reviewer: "independent-reviewer",
        });
        const acceptanceFailure = await callTool(server.client, "work_complete", {
          id: missingAcceptance.id,
          expectedVersion: 3,
          acceptance: [],
        });
        expect(acceptanceFailure.ok).toBe(false);
        if (!acceptanceFailure.ok) {
          expect(acceptanceFailure.code).toBe("ACCEPTANCE_INCOMPLETE");
          expect(acceptanceFailure.data.missing).toEqual(["項目 A"]);
        }

        const missingEvidence = workOf(
          await callToolOk(server.client, "work_create", {
            title: "缺少證據",
            acceptance: ["項目 B"],
            risk: "low",
          }),
        );
        await callToolOk(server.client, "work_update", {
          id: missingEvidence.id,
          expectedVersion: 1,
          status: "in_progress",
        });
        await callToolOk(server.client, "work_review", {
          id: missingEvidence.id,
          expectedVersion: 2,
          verdict: "approve",
          reviewer: "independent-reviewer",
        });
        const evidenceFailure = await callTool(server.client, "work_complete", {
          id: missingEvidence.id,
          expectedVersion: 3,
          acceptance: [{ criterion: "項目 B", met: true, evidenceIds: [] }],
        });
        expect(evidenceFailure.ok).toBe(false);
        if (!evidenceFailure.ok) {
          expect(evidenceFailure.code).toBe("EVIDENCE_REQUIRED");
          expect(evidenceFailure.data.criteriaWithoutEvidence).toEqual(["項目 B"]);
        }

        const highRisk = workOf(
          await callToolOk(server.client, "work_create", {
            title: "高風險缺少核准",
            acceptance: ["項目 C"],
            risk: "high",
          }),
        );
        const highRiskStarted = await callToolOk(server.client, "work_update", {
          id: highRisk.id,
          expectedVersion: 1,
          status: "in_progress",
          evidence: [{ kind: "note", summary: "人工檢查紀錄" }],
        });
        const noteEvidence = (highRiskStarted.evidence as EvidenceReference[])[0];
        if (!noteEvidence) throw new Error("work_update 沒有建立人工證據。");
        await callToolOk(server.client, "work_review", {
          id: highRisk.id,
          expectedVersion: 2,
          verdict: "concerns",
          reviewer: "independent-reviewer",
          note: "尚未提供伺服器證據。",
        });
        const highRiskFailure = await callTool(server.client, "work_complete", {
          id: highRisk.id,
          expectedVersion: 3,
          acceptance: [{ criterion: "項目 C", met: true, evidenceIds: [noteEvidence.evidenceId] }],
        });
        expect(highRiskFailure.ok).toBe(false);
        if (!highRiskFailure.ok) {
          expect(highRiskFailure.code).toBe("REVIEW_REQUIRED");
          expect(highRiskFailure.data.blockedBy).toContain("SERVER_EVIDENCE_REQUIRED");
        }

        const ownerApproval = workOf(
          await callToolOk(server.client, "work_create", {
            title: "owner 不能自我核准",
            acceptance: ["項目 D"],
            risk: "low",
          }),
        );
        await callToolOk(server.client, "work_update", {
          id: ownerApproval.id,
          expectedVersion: 1,
          status: "in_progress",
        });
        const ownerFailure = await callTool(server.client, "work_review", {
          id: ownerApproval.id,
          expectedVersion: 2,
          verdict: "approve",
        });
        expect(ownerFailure.ok).toBe(false);
        if (!ownerFailure.ok) {
          expect(ownerFailure.code).toBe("REVIEWER_IS_OWNER");
        }

        // 失敗的結案與審查都不能偷偷推進版本或狀態。
        for (const work of [missingAcceptance, missingEvidence, highRisk, ownerApproval]) {
          const latest = await callToolOk(server.client, "work_get", { id: work.id });
          expect((latest.work as WorkReference).status).not.toBe("done");
        }
      } finally {
        await server.close();
      }
    });
  }, 60_000);
});
