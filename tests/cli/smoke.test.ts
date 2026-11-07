import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createRepo,
  parseJson,
  runCli,
  withCliEnvironment,
} from "./helpers.ts";

const subcommands = [
  "mcp",
  "export-v3",
  "import",
  "export",
  "link",
  "transcripts",
  "doctor",
  "hooks",
  "usage",
  "project",
] as const;

const helpCommands = new Set([
  "export-v3",
  "import",
  "export",
  "link",
  "transcripts",
  "doctor",
  "hooks",
  "usage",
  "project",
]);

interface DoctorPayload {
  ok: boolean;
  exitCode: number;
  checks: Array<{ name: string; status: "ok" | "warn"; detail: string }>;
  report: { version: { name: string; version: string } };
}

describe("CLI 冒煙測試", () => {
  test("--help 以 0 結束並列出所有子命令", async () => {
    await withCliEnvironment("cli-help", async ({ env }) => {
      const result = await runCli(["--help"], env);

      expect(result.exitCode).toBe(0);
      for (const name of subcommands) {
        expect(result.stdout).toMatch(new RegExp(`^  ${name}\\s`, "m"));
      }
    });
  });

  test("沒有參數時顯示說明", async () => {
    await withCliEnvironment("cli-no-args", async ({ env }) => {
      const result = await runCli([], env);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("用法：");
    });
  });

  test("每個子命令都能顯示說明", async () => {
    await withCliEnvironment("cli-subcommand-help", async ({ env }) => {
      for (const name of helpCommands) {
        const result = await runCli([name, "--help"], env);

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain("用法");
        expect(result.stdout + result.stderr).not.toContain("未知的子命令");
      }
    });
  }, 30_000);

  test("mcp 已實作，stdin 關閉後以 0 結束", async () => {
    await withCliEnvironment("cli-mcp", async ({ env }) => {
      const result = await runCli(["mcp"], env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("尚未實作");
    });
  }, 30_000);

  test("project list 會登記並列出專案", async () => {
    await withCliEnvironment("cli-project", async ({ env, root }) => {
      const repo = await createRepo(join(root, "repo"));
      const result = await runCli(["project", "list", "--project", repo, "--json"], env);

      expect(result.exitCode).toBe(0);
      const payload = parseJson<{ projects: Array<{ projectId: string; rootPath: string }> }>(
        result.stdout,
      );
      expect(payload.projects).toHaveLength(1);
      expect(payload.projects[0]?.projectId).toMatch(/^[0-9a-f]{8,}$/);
      expect(payload.projects[0]?.rootPath).toBe(realpathSync(repo));
    });
  }, 30_000);

  test("doctor --json 回報實際檢查結果，不再是未實作訊息", async () => {
    await withCliEnvironment("cli-doctor", async ({ env }) => {
      const result = await runCli(["doctor", "--json"], env);

      expect([0, 1]).toContain(result.exitCode);
      expect(result.stdout + result.stderr).not.toContain("尚未實作");
      const payload = parseJson<DoctorPayload>(result.stdout);
      expect(payload.report.version.name).toBe("smilework");
      expect(payload.checks.map((check) => check.name)).toEqual([
        "設定",
        "資料庫",
        "專案",
        "actor",
        "技能連結",
        "對話索引",
      ]);
      expect(payload.checks.some((check) => check.status === "warn")).toBe(true);
      expect(payload.ok).toBe(result.exitCode === 0);
    });
  }, 30_000);

  test("hooks 可以安裝、查詢、檢查並移除 pre-commit", async () => {
    await withCliEnvironment("cli-hooks", async ({ env, root }) => {
      const repo = await createRepo(join(root, "repo"));

      const before = await runCli(["hooks", "status", "--project", repo, "--json"], env);
      expect(before.exitCode).toBe(0);
      expect(parseJson(before.stdout)).toMatchObject({ installed: false, foreign: false });

      const installed = await runCli(["hooks", "install", "--project", repo, "--json"], env);
      expect(installed.exitCode).toBe(0);
      expect(parseJson(installed.stdout)).toMatchObject({ status: "installed" });

      const after = await runCli(["hooks", "status", "--project", repo, "--json"], env);
      expect(parseJson(after.stdout)).toMatchObject({ installed: true, managed: true });

      const checked = await runCli(
        ["hooks", "check", "--project", repo, "--staged", "--json"],
        env,
      );
      expect(checked.exitCode).toBe(0);
      expect(parseJson(checked.stdout)).toMatchObject({ ok: true, findings: [] });

      const removed = await runCli(["hooks", "uninstall", "--project", repo, "--json"], env);
      expect(removed.exitCode).toBe(0);
      expect(parseJson(removed.stdout)).toMatchObject({ status: "removed" });
    });
  }, 30_000);

  test("usage record 會寫入一筆使用事件", async () => {
    await withCliEnvironment("cli-usage", async ({ env, root }) => {
      const repo = await createRepo(join(root, "repo"));
      const result = await runCli(
        [
          "usage",
          "record",
          "--action",
          "skill_read",
          "--knowledge",
          "knowledge-smoke",
          "--layer",
          "global",
          "--project",
          repo,
          "--json",
        ],
        env,
      );

      expect(result.exitCode).toBe(0);
      const payload = parseJson<{
        usage: { usageId: string; action: string; actor: string; projectId: string | null };
      }>(result.stdout);
      expect(payload.usage.usageId).toStartWith("usage-");
      expect(payload.usage.action).toBe("skill_read");
      expect(payload.usage.actor).toBe("unknown");
      expect(payload.usage.projectId).toMatch(/^[0-9a-f]{8,}$/);
    });
  }, 30_000);

  test("transcripts status 會在尚未索引時回報 exists=false", async () => {
    await withCliEnvironment("cli-transcripts", async ({ env }) => {
      const result = await runCli(["transcripts", "status"], env);

      expect(result.exitCode).toBe(0);
      const payload = parseJson<{ exists: boolean; ready: boolean; entries: number }>(
        result.stdout,
      );
      expect(payload).toMatchObject({ exists: false, ready: false, entries: 0 });
    });
  }, 30_000);

  test("未知的子命令以非 0 結束並提示", async () => {
    await withCliEnvironment("cli-unknown", async ({ env }) => {
      const result = await runCli(["no-such-command"], env);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("未知的子命令：no-such-command");
    });
  });
});
