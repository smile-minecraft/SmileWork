import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db/index.ts";
import { registerProject, resolveProject } from "../../src/project/index.ts";
import { createWork } from "../../src/work/crud.ts";
import {
  createRepo,
  parseJson,
  runCli,
  runGit,
  withCliEnvironment,
} from "./helpers.ts";

interface HookStatusPayload {
  hookPath: string;
  installed: boolean;
  managed: boolean;
  foreign: boolean;
}

interface HookCheckPayload {
  ok: boolean;
  registered: number;
  findings: Array<{ id: string; path: string; line: number | null; text: string }>;
}

interface HookInstallPayload {
  hookPath: string;
  status: string;
}

function hookPath(repo: string): string {
  return join(realpathSync(repo), ".git", "hooks", "pre-commit");
}

/** 建立一筆已登記的工作，回傳它的 work ID；hook 檢查的就是這份清單。 */
function seedRegisteredWork(repo: string, home: string, env: NodeJS.ProcessEnv): string {
  const db = openDatabase({ home });
  try {
    const project = resolveProject({ explicitPath: repo, env });
    registerProject(db, project);
    createWork(
      db,
      project,
      { name: "build", model: "test-model", declared: true },
      {
        kind: "task",
        title: "hook fixture",
        nonGoals: [],
        contextRefs: [],
        scopePaths: [],
        acceptance: [],
        dependsOn: [],
        priority: "normal",
        risk: "low",
        labels: [],
      },
    );
    const row = db.query<{ work_id: string }, []>("SELECT work_id FROM work_items").get();
    if (!row) throw new Error("沒有建立測試工作");
    return row.work_id;
  } finally {
    db.close();
  }
}

async function stageFile(repo: string, name: string, content: string): Promise<void> {
  writeFileSync(join(repo, name), content, "utf8");
  await runGit(repo, ["add", name]);
}

describe("hooks 子命令", () => {
  test("install 建立可執行的 pre-commit，重複安裝不重寫", async () => {
    await withCliEnvironment("cli-hooks-install", async (context) => {
      const repo = await createRepo(join(context.root, "repo"));

      const first = await runCli(
        ["hooks", "install", "--project", repo, "--json"],
        context.env,
      );
      expect(first.exitCode).toBe(0);
      const installed = parseJson<HookInstallPayload>(first.stdout);
      expect(installed.status).toBe("installed");
      expect(installed.hookPath).toBe(hookPath(repo));

      const path = hookPath(repo);
      expect(existsSync(path)).toBe(true);
      const mode = statSync(path).mode & 0o111;
      expect(mode).not.toBe(0);
      const content = readFileSync(path, "utf8");
      expect(content).toContain("smilework-managed-hook");
      expect(content).toContain("hooks check --staged");

      const second = await runCli(
        ["hooks", "install", "--project", repo, "--json"],
        context.env,
      );
      expect(second.exitCode).toBe(0);
      expect(parseJson<HookInstallPayload>(second.stdout).status).toBe("unchanged");

      const status = await runCli(["hooks", "status", "--project", repo, "--json"], context.env);
      expect(status.exitCode).toBe(0);
      expect(parseJson<HookStatusPayload>(status.stdout)).toMatchObject({
        installed: true,
        managed: true,
        foreign: false,
      });
    });
  }, 30_000);

  test("既有 hook 不被覆蓋，--force 才覆蓋", async () => {
    await withCliEnvironment("cli-hooks-force", async (context) => {
      const repo = await createRepo(join(context.root, "repo"));
      const path = hookPath(repo);
      const foreign = "#!/bin/sh\necho 既有 hook\n";
      writeFileSync(path, foreign, { encoding: "utf8", mode: 0o755 });

      const blocked = await runCli(
        ["hooks", "install", "--project", repo, "--json"],
        context.env,
      );
      expect(blocked.exitCode).toBe(1);
      expect(parseJson<HookInstallPayload>(blocked.stdout).status).toBe("blocked");
      expect(readFileSync(path, "utf8")).toBe(foreign);

      const forced = await runCli(
        ["hooks", "install", "--project", repo, "--force", "--json"],
        context.env,
      );
      expect(forced.exitCode).toBe(0);
      expect(parseJson<HookInstallPayload>(forced.stdout).status).toBe("replaced");
      expect(readFileSync(path, "utf8")).toContain("smilework-managed-hook");
      expect(statSync(path).mode & 0o111).not.toBe(0);
    });
  }, 30_000);

  test("uninstall 只移除本工具的 hook，不動其他 hook", async () => {
    await withCliEnvironment("cli-hooks-uninstall", async (context) => {
      const repo = await createRepo(join(context.root, "repo"));
      const path = hookPath(repo);

      await runCli(["hooks", "install", "--project", repo, "--json"], context.env);
      const removed = await runCli(["hooks", "uninstall", "--project", repo, "--json"], context.env);
      expect(removed.exitCode).toBe(0);
      expect(parseJson<{ status: string }>(removed.stdout).status).toBe("removed");
      expect(existsSync(path)).toBe(false);

      const foreign = "#!/bin/sh\necho 別人的 hook\n";
      writeFileSync(path, foreign, { encoding: "utf8", mode: 0o755 });
      const kept = await runCli(["hooks", "uninstall", "--project", repo, "--json"], context.env);
      expect(kept.exitCode).toBe(0);
      expect(parseJson<{ status: string }>(kept.stdout).status).toBe("foreign");
      expect(readFileSync(path, "utf8")).toBe(foreign);
    });
  }, 30_000);

  test("已安裝的 hook 放行乾淨的提交，阻擋含已登記 ID 的提交", async () => {
    await withCliEnvironment("cli-hooks-run", async (context) => {
      const repo = await createRepo(join(context.root, "repo"));
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };
      const workId = seedRegisteredWork(repo, context.home, env);
      await runCli(["hooks", "install", "--project", repo], env);

      await stageFile(repo, "clean.md", "沒有識別碼的內容\n");
      const clean = await runHook(hookPath(repo), repo, env);
      expect(clean.exitCode).toBe(0);

      await runGit(repo, ["reset", "-q"]);
      await stageFile(repo, "dirty.md", `請參考 ${workId} 的說明\n`);
      const dirty = await runHook(hookPath(repo), repo, env);
      expect(dirty.exitCode).toBe(1);
      expect(dirty.stderr).toContain(workId);
      expect(dirty.stderr).toContain("dirty.md");
    });
  }, 30_000);

  test("hooks check 找出暫存內容與檔名裡的已登記 ID", async () => {
    await withCliEnvironment("cli-hooks-check", async (context) => {
      const repo = await createRepo(join(context.root, "repo"));
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };
      const workId = seedRegisteredWork(repo, context.home, env);

      await stageFile(repo, "notes.md", "乾淨內容\n");
      const clean = await runCli(["hooks", "check", "--staged", "--json"], env, repo);
      expect(clean.exitCode).toBe(0);
      const cleanPayload = parseJson<HookCheckPayload>(clean.stdout);
      expect(cleanPayload.ok).toBe(true);
      expect(cleanPayload.registered).toBe(1);
      expect(cleanPayload.findings).toEqual([]);

      await stageFile(repo, `${workId}.txt`, "檔名帶識別碼\n");
      const dirty = await runCli(["hooks", "check", "--staged", "--json"], env, repo);
      expect(dirty.exitCode).toBe(1);
      const dirtyPayload = parseJson<HookCheckPayload>(dirty.stdout);
      expect(dirtyPayload.ok).toBe(false);
      expect(dirtyPayload.findings.some((finding) => finding.id === workId)).toBe(true);
      expect(dirtyPayload.findings.some((finding) => finding.path.endsWith(`${workId}.txt`))).toBe(
        true,
      );
    });
  }, 30_000);

  test("資料庫不存在時 hook check 不阻擋提交", async () => {
    await withCliEnvironment("cli-hooks-no-db", async (context) => {
      const repo = await createRepo(join(context.root, "repo"));
      const payload = "work-00000000-0000-4000-8000-000000000000";
      await stageFile(repo, "notes.md", `${payload}\n`);

      const result = await runCli(["hooks", "check", "--staged", "--json"], context.env, repo);
      expect(result.exitCode).toBe(0);
      expect(parseJson<HookCheckPayload>(result.stdout).registered).toBe(0);
    });
  }, 30_000);
});

async function runHook(
  path: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([path], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
