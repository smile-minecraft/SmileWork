import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectFail, expectOk, withWorkTools, type WorkTestContext } from "./helpers.ts";

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "SmileWork Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "SmileWork Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失敗：${result.stderr}`);
}

/** 在 repo 放入通過（或失敗）的 scripts/verify.sh 並提交，讓它不算工作的改動。 */
function commitVerifyScript(context: WorkTestContext, exitCode = 0): void {
  mkdirSync(join(context.projectPath, "scripts"), { recursive: true });
  const script = join(context.projectPath, "scripts", "verify.sh");
  writeFileSync(script, `#!/bin/sh\necho "verify ran"\nexit ${exitCode}\n`, "utf8");
  chmodSync(script, 0o755);
  git(context.projectPath, ["add", "scripts/verify.sh"]);
  git(context.projectPath, ["commit", "-m", "add verify script"]);
}

async function startWork(
  context: WorkTestContext,
  input: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const work = expectOk(
    await context.call("work_create", { title: "送審閘門", risk: "medium", ...input }),
  ).data.work;
  const started = expectOk(
    await context.call("work_update", { id: work.id, expectedVersion: 1, status: "in_progress" }),
  ).data.work;
  return { id: started.id, version: started.version };
}

async function verify(context: WorkTestContext, workId: string) {
  return expectOk(
    await context.call("verify_run", { workId, runner: "script", script: "verify" }),
  ).data;
}

describe("認領保護", () => {
  test("open → in_progress 會把 owner 設為呼叫者，其他代理需要 takeover 或 handoff", async () => {
    await withWorkTools(async (context) => {
      const created = expectOk(
        await context.callAs("planner", "work_create", { title: "認領", risk: "low" }),
      ).data.work;
      expect(created.owner).toBe("planner");

      const claimed = expectOk(
        await context.call("work_update", { id: created.id, expectedVersion: 1, status: "in_progress" }),
      ).data.work;
      expect(claimed).toMatchObject({ owner: "build", status: "in_progress", version: 2 });

      const blocked = expectFail(
        await context.callAs("intruder", "work_update", {
          id: created.id,
          expectedVersion: 2,
          title: "被改掉",
        }),
      );
      expect(blocked.code).toBe("WORK_ALREADY_CLAIMED");
      expect(blocked.data).toEqual({ workId: created.id, currentOwner: "build", currentVersion: 2 });

      const handedOff = expectOk(
        await context.callAs("helper", "work_update", {
          id: created.id,
          expectedVersion: 2,
          evidence: [
            {
              kind: "handoff",
              summary: "協助交接",
              details: { currentState: "已補上說明", decisions: [], nextSteps: [], unverified: [] },
            },
          ],
        }),
      ).data.work;
      expect(handedOff).toMatchObject({ owner: "build", version: 3 });

      const takenOver = expectOk(
        await context.callAs("intruder", "work_update", {
          id: created.id,
          expectedVersion: 3,
          takeover: true,
        }),
      ).data.work;
      expect(takenOver).toMatchObject({ owner: "intruder", version: 4 });

      const formerOwner = expectFail(
        await context.call("work_update", { id: created.id, expectedVersion: 4, title: "搶回" }),
      );
      expect(formerOwner.code).toBe("WORK_ALREADY_CLAIMED");
      expect(formerOwner.data).toMatchObject({ currentOwner: "intruder" });
    });
  });
});

describe("送審（in_progress → review）的硬閘門", () => {
  test("中風險需要在目前工作區上成功的 verify_run 證據", async () => {
    await withWorkTools(async (context) => {
      commitVerifyScript(context);
      const work = await startWork(context);

      const verified = await verify(context, work.id);
      expect(verified).toMatchObject({ passed: true, workingTreeClean: true });
      expect(verified.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);

      const submitted = expectOk(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      ).data.work;
      expect(submitted).toMatchObject({ status: "review", version: work.version + 1 });
    });
  });

  test("驗證之後改動任何檔案會讓證據過期，重跑後才能送審", async () => {
    await withWorkTools(async (context) => {
      commitVerifyScript(context);
      const work = await startWork(context);
      await verify(context, work.id);

      writeFileSync(join(context.projectPath, "notes.txt"), "驗證後才加的檔案\n", "utf8");
      const stale = expectFail(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
      expect(stale.code).toBe("SERVER_EVIDENCE_STALE");
      expect(stale.data.currentTreeFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect((stale.data as any).latestPassing.treeFingerprint).not.toBe(stale.data.currentTreeFingerprint);

      // 再改一次同一個未追蹤檔案的內容，指紋也要跟著變。
      const rerun = await verify(context, work.id);
      writeFileSync(join(context.projectPath, "notes.txt"), "內容又改了\n", "utf8");
      const staleAgain = expectFail(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
      expect(staleAgain.code).toBe("SERVER_EVIDENCE_STALE");
      expect((staleAgain.data as any).latestPassing.evidenceId).toBe(rerun.evidence.evidenceId);

      await verify(context, work.id);
      expectOk(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
    });
  });

  test("只有失敗的證據時回 SERVER_EVIDENCE_FAILED 並附上輸出路徑", async () => {
    await withWorkTools(async (context) => {
      commitVerifyScript(context, 1);
      const work = await startWork(context);
      const failed = await verify(context, work.id);
      expect(failed.passed).toBe(false);

      const rejected = expectFail(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
      expect(rejected.code).toBe("SERVER_EVIDENCE_FAILED");
      expect(rejected.data.latestFailed).toMatchObject({
        evidenceId: failed.evidence.evidenceId,
        exitCode: 1,
        outputPath: failed.outputPath,
      });
    });
  });

  test("新增跳過測試的寫法會被 diff 衛生擋下，ruling 寫明規則後放行", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context, { risk: "low" });
      mkdirSync(join(context.projectPath, "tests"), { recursive: true });
      writeFileSync(
        join(context.projectPath, "tests", "a.test.ts"),
        ['import { test } from "bun:test";', 'test.skip("暫時跳過", () => {});', ""].join("\n"),
        "utf8",
      );

      const rejected = expectFail(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
      expect(rejected.code).toBe("DIFF_HYGIENE_FAILED");
      expect(rejected.data.findings).toEqual([
        { rule: "test-skip", path: "tests/a.test.ts", line: 2, snippet: 'test.skip("暫時跳過", () => {});' },
      ]);

      const submitted = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "review",
          evidence: [
            {
              kind: "ruling",
              summary: "保留 test-skip",
              details: {
                decision: "允許 test-skip：外部服務停機期間暫停這個測試",
                rationale: "服務恢復後由後續工作移除",
              },
            },
          ],
        }),
      ).data.work;
      expect(submitted.status).toBe("review");
    });
  });

  test("scopePaths 以外的改動回 SCOPE_VIOLATION，scope-override ruling 可以放行", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context, { risk: "low", scopePaths: ["src/"] });
      mkdirSync(join(context.projectPath, "src"), { recursive: true });
      writeFileSync(join(context.projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
      writeFileSync(join(context.projectPath, "README.md"), "# 改到範圍外\n", "utf8");

      const rejected = expectFail(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
      expect(rejected.code).toBe("SCOPE_VIOLATION");
      expect(rejected.data.scopeViolations).toEqual(["README.md"]);

      expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "review",
          evidence: [
            {
              kind: "ruling",
              summary: "README 一起更新",
              details: { decision: "scope-override：README 需要同步說明", rationale: "文件與程式一致" },
            },
          ],
        }),
      );
    });
  });

  test("低風險且工作區乾淨時不需要伺服器證據", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context, { risk: "low" });
      expectOk(
        await context.call("work_update", { id: work.id, expectedVersion: work.version, status: "review" }),
      );
    });
  });

  test("同一次呼叫把風險降成 low 也不能繞過證據閘門", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context);
      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "review",
          risk: "low",
        }),
      );
      expect(rejected.code).toBe("SERVER_EVIDENCE_REQUIRED");
    });
  });
});

describe("work_complete 的工作區閘門", () => {
  test("中風險結案要求證據仍然新鮮，也會檢查 diff 衛生", async () => {
    await withWorkTools(async (context) => {
      commitVerifyScript(context);
      const work = await startWork(context, { acceptance: ["驗證通過"] });
      const verified = await verify(context, work.id);
      const acceptance = [
        { criterion: "驗證通過", met: true, evidenceIds: [verified.evidence.evidenceId] },
      ];

      writeFileSync(join(context.projectPath, "late.ts"), "// @ts-ignore\nexport const x = 1;\n", "utf8");
      const stale = expectFail(
        await context.call("work_complete", { id: work.id, expectedVersion: work.version, acceptance }),
      );
      expect(stale.code).toBe("SERVER_EVIDENCE_STALE");
      expect(stale.data.blockedBy).toContain("DIFF_HYGIENE_FAILED");

      const rerun = await verify(context, work.id);
      const hygiene = expectFail(
        await context.call("work_complete", {
          id: work.id,
          expectedVersion: work.version,
          acceptance: [
            { criterion: "驗證通過", met: true, evidenceIds: [rerun.evidence.evidenceId] },
          ],
        }),
      );
      expect(hygiene.code).toBe("DIFF_HYGIENE_FAILED");
      expect(hygiene.data.findings).toEqual([
        { rule: "ts-ignore", path: "late.ts", line: 1, snippet: "// @ts-ignore" },
      ]);
    });
  });
});

describe("work_update 回應的證據精簡", () => {
  test("output 超過 500 字時回應截斷並標記，work_get 仍回完整內容", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context, { risk: "low" });
      const long = "x".repeat(1200);
      const updated = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          evidence: [
            { kind: "note", summary: "長輸出", output: long },
            { kind: "note", summary: "短輸出", output: "ok" },
          ],
        }),
      ).data;
      const [longEvidence, shortEvidence] = updated.addedEvidence;
      expect(longEvidence.output).toHaveLength(500);
      expect(longEvidence.outputTruncated).toBe(true);
      expect(shortEvidence.output).toBe("ok");
      expect(shortEvidence.outputTruncated).toBeUndefined();
      expect(updated.evidence[0].outputTruncated).toBe(true);

      const fetched = expectOk(await context.call("work_get", { id: work.id })).data;
      expect(fetched.evidence[0].output).toBe(long);
    });
  });
});
