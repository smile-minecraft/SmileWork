import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectFail, expectOk, withWorkTools, type WorkTestContext } from "./helpers.ts";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "SmileWork Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "SmileWork Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} 失敗：${result.stderr.toString() || result.stdout.toString()}`);
  }
  return result.stdout.toString().trim();
}

function commitVerifyScript(context: WorkTestContext): void {
  mkdirSync(join(context.projectPath, "scripts"), { recursive: true });
  const script = join(context.projectPath, "scripts", "verify.sh");
  writeFileSync(script, "#!/bin/sh\necho ok\nexit 0\n", "utf8");
  chmodSync(script, 0o755);
  git(context.projectPath, ["add", "scripts/verify.sh"]);
  git(context.projectPath, ["commit", "-m", "add verify script"]);
}

async function startWork(
  context: WorkTestContext,
  input: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const created = expectOk(
    await context.call("work_create", { title: "base commit", risk: "low", ...input }),
  ).data.work;
  const started = expectOk(
    await context.call("work_update", {
      id: created.id,
      expectedVersion: created.version,
      status: "in_progress",
    }),
  ).data.work;
  return { id: started.id, version: started.version };
}

/** 建立 feature 與 upstream 兩條分支，再把 upstream merge 回 feature。 */
async function mergeUpstream(context: WorkTestContext): Promise<{ base: string; upstream: string }> {
  const base = git(context.projectPath, ["rev-parse", "HEAD"]);
  git(context.projectPath, ["checkout", "-b", "feature"]);
  mkdirSync(join(context.projectPath, "src"), { recursive: true });
  writeFileSync(join(context.projectPath, "src", "app.ts"), "export const app = true;\n", "utf8");
  git(context.projectPath, ["add", "src/app.ts"]);
  git(context.projectPath, ["commit", "-m", "feature change"]);

  git(context.projectPath, ["checkout", "main"]);
  mkdirSync(join(context.projectPath, "docs"), { recursive: true });
  writeFileSync(join(context.projectPath, "docs", "upstream.md"), "upstream only\n", "utf8");
  git(context.projectPath, ["add", "docs/upstream.md"]);
  git(context.projectPath, ["commit", "-m", "upstream change"]);
  const upstream = git(context.projectPath, ["rev-parse", "HEAD"]);
  git(context.projectPath, ["update-ref", "refs/remotes/origin/main", upstream]);
  git(context.projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  git(context.projectPath, ["checkout", "feature"]);
  git(context.projectPath, ["merge", "--no-ff", "main", "-m", "merge upstream"]);
  return { base, upstream };
}

describe("work_update baseCommit refresh", () => {
  test("純上游越界回 stale-base 診斷，refresh 後可送審且事件可稽核", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context, { scopePaths: ["src/"] });
      const { base, upstream } = await mergeUpstream(context);

      const stale = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "review",
        }),
      );
      expect(stale.code).toBe("BASE_BEHIND_UPSTREAM");
      expect(stale.data).toMatchObject({
        previousBaseRef: base,
        baseRef: upstream,
        upstreamRef: "origin/main",
        scopeViolations: ["docs/upstream.md"],
      });

      const refreshed = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
        }),
      ).data;
      expect(refreshed.work).toMatchObject({ baseCommit: upstream, version: work.version + 1 });
      expect(refreshed.baseCommitRefresh).toMatchObject({
        changed: true,
        previousBaseCommit: base,
        baseCommit: upstream,
        upstreamRef: "origin/main",
      });

      const db = context.openDb();
      try {
        const event = db
          .query<{ kind: string; details: string | null }, [string]>(
            "SELECT kind, details FROM events WHERE work_id = ? AND kind = 'base_commit_refreshed'",
          )
          .get(work.id);
        expect(event?.kind).toBe("base_commit_refreshed");
        expect(JSON.parse(event?.details ?? "{}")).toMatchObject({
          previousBaseCommit: base,
          baseCommit: upstream,
          upstreamRef: "origin/main",
        });
      } finally {
        db.close();
      }

      const submitted = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: refreshed.work.version,
          status: "review",
        }),
      ).data.work;
      expect(submitted.status).toBe("review");

      const brief = expectOk(
        await context.call("work_get", { id: work.id, format: "brief" }),
      ).data.brief as string;
      expect(brief).toContain(`git diff ${upstream}`);
      expect(brief).not.toContain("工作建立時的 HEAD");
    });
  });

  test("refresh 可與送審同一呼叫完成，工作區沒有變動時不需重跑證據", async () => {
    await withWorkTools(async (context) => {
      commitVerifyScript(context);
      const work = await startWork(context, { risk: "medium", scopePaths: ["src/"] });
      const { upstream } = await mergeUpstream(context);
      const verified = expectOk(
        await context.call("verify_run", { workId: work.id, runner: "script", script: "verify" }),
      ).data;

      const submitted = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
          status: "review",
        }),
      ).data;
      expect(submitted.work).toMatchObject({ status: "review", baseCommit: upstream });
      expect(submitted.baseCommitRefresh.changed).toBe(true);
      expect(verified.passed).toBe(true);
    });
  });

  test("work_update 拒絕任意 baseCommit 與未知欄位", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context);
      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          baseCommit: git(context.projectPath, ["rev-parse", "HEAD"]),
        }),
      );
      expect(rejected.code).toBe("VALIDATION_ERROR");
      expect(rejected.data.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("baseCommit") }),
        ]),
      );
    });
  });

  test("沒有受信任 upstream 時回 UPSTREAM_NOT_FOUND", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context);
      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
        }),
      );
      expect(rejected.code).toBe("UPSTREAM_NOT_FOUND");
      expect(rejected.nextAction).toContain("fetch");
    });
  });

  test("基準已經等於上游 merge-base 時回 changed: false，不寫 refresh 事件", async () => {
    await withWorkTools(async (context) => {
      const head = git(context.projectPath, ["rev-parse", "HEAD"]);
      git(context.projectPath, ["update-ref", "refs/remotes/origin/main", head]);
      git(context.projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const work = await startWork(context);

      const refreshed = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
        }),
      ).data;
      expect(refreshed.baseCommitRefresh).toMatchObject({ changed: false, baseCommit: head });
      expect(refreshed.work.baseCommit).toBe(head);

      const db = context.openDb();
      try {
        const count = db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM events WHERE work_id = ? AND kind = 'base_commit_refreshed'",
          )
          .get(work.id);
        expect(count?.count).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  test("非 owner 不能藉 refresh 取得上游資訊或改動工作", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context);
      const rejected = expectFail(
        await context.callAs("intruder", "work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
        }),
      );
      expect(rejected.code).toBe("WORK_ALREADY_CLAIMED");
    });
  });

  test("refresh 只往前，不把基準退回較舊上游", async () => {
    await withWorkTools(async (context) => {
      const older = git(context.projectPath, ["rev-parse", "HEAD"]);
      writeFileSync(join(context.projectPath, "local.md"), "local base\n", "utf8");
      git(context.projectPath, ["add", "local.md"]);
      git(context.projectPath, ["commit", "-m", "local base"]);
      const work = await startWork(context);
      git(context.projectPath, ["update-ref", "refs/remotes/origin/main", older]);
      git(context.projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
        }),
      );
      expect(rejected.code).toBe("BASE_COMMIT_NOT_FORWARD");
    });
  });

  test("上游檔案又被工作改過時仍是真正的 SCOPE_VIOLATION", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context, { scopePaths: ["src/"] });
      await mergeUpstream(context);
      writeFileSync(join(context.projectPath, "docs", "upstream.md"), "work changed this too\n", "utf8");

      const rejected = expectFail(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "review",
        }),
      );
      expect(rejected.code).toBe("SCOPE_VIOLATION");
      expect(rejected.data.scopeViolations).toContain("docs/upstream.md");
    });
  });

  test("結案也回 stale-base 診斷，refresh 後同一份新鮮證據可結案", async () => {
    await withWorkTools(async (context) => {
      commitVerifyScript(context);
      const work = await startWork(context, {
        risk: "medium",
        scopePaths: ["src/"],
        acceptance: ["驗證通過"],
      });
      await mergeUpstream(context);
      const verified = expectOk(
        await context.call("verify_run", { workId: work.id, runner: "script", script: "verify" }),
      ).data;
      const acceptance = [
        { criterion: "驗證通過", met: true, evidenceIds: [verified.evidence.evidenceId] },
      ];

      const stale = expectFail(
        await context.call("work_complete", {
          id: work.id,
          expectedVersion: work.version,
          acceptance,
        }),
      );
      expect(stale.code).toBe("BASE_BEHIND_UPSTREAM");

      const refreshed = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          refreshBaseCommit: true,
        }),
      ).data.work;
      const completed = expectOk(
        await context.call("work_complete", {
          id: work.id,
          expectedVersion: refreshed.version,
          acceptance,
        }),
      ).data;
      expect(completed).toMatchObject({ status: "done", resolution: "completed" });
    });
  });

  test("review 狀態不允許再刷新基準", async () => {
    await withWorkTools(async (context) => {
      const work = await startWork(context);
      const submitted = expectOk(
        await context.call("work_update", {
          id: work.id,
          expectedVersion: work.version,
          status: "review",
        }),
      ).data.work;
      const rejected = expectFail(
        await context.call("work_update", {
          id: submitted.id,
          expectedVersion: submitted.version,
          refreshBaseCommit: true,
        }),
      );
      expect(rejected.code).toBe("BASE_REFRESH_NOT_ALLOWED");
    });
  });
});
