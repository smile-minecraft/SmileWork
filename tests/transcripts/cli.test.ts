import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  claudeAssistant,
  claudeUser,
  createOpencodeV2Database,
  insertRawOpencodeMessage,
  withTranscriptEnv,
  writeClaudeJsonl,
} from "./helpers.ts";

const repoRoot = join(import.meta.dir, "..", "..");

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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

describe("transcripts 子命令", () => {
  test("index 建立索引，status 回報筆數與來源", async () => {
    await withTranscriptEnv("cli-transcripts", async (context) => {
      await writeClaudeJsonl(context.fakeHome, "cli.jsonl", [
        claudeUser("cli index message"),
        claudeAssistant("cli assistant message"),
      ]);
      const env = {
        ...context.env,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "codex,opencode",
      };

      const index = await runCli(["transcripts", "index"], env);
      expect(index.exitCode).toBe(0);
      const report = JSON.parse(index.stdout) as {
        skipped: boolean;
        totals: { entries: number };
      };
      expect(report.skipped).toBe(false);
      expect(report.totals.entries).toBe(2);

      const status = await runCli(["transcripts", "status"], env);
      expect(status.exitCode).toBe(0);
      const state = JSON.parse(status.stdout) as {
        exists: boolean;
        ready: boolean;
        entries: number;
        sources: Record<string, boolean>;
      };
      expect(state.exists).toBe(true);
      expect(state.ready).toBe(true);
      expect(state.entries).toBe(2);
      expect(state.sources.claude).toBe(true);
      expect(state.sources.codex).toBe(false);
    });
  }, 30_000);

  test("OpenCode 警告會出現在 index 報告與 status 計數", async () => {
    await withTranscriptEnv("cli-transcripts-warning", async (context) => {
      const dbPath = join(context.xdgDataHome, "opencode", "opencode.db");
      const baseTime = Date.parse("2026-11-06T08:00:00.000Z");
      createOpencodeV2Database(
        dbPath,
        [{ id: "ses_cli_warning", directory: "/work/cli-warning", timeUpdated: baseTime }],
        [
          {
            id: "msg_cli_valid",
            sessionId: "ses_cli_warning",
            type: "user",
            seq: 1,
            timeCreated: baseTime,
            timeUpdated: baseTime,
            data: { text: "cli opencode message", time: { created: baseTime } },
          },
        ],
      );
      insertRawOpencodeMessage(dbPath, {
        id: "msg_cli_bad",
        sessionId: "ses_cli_warning",
        type: "user",
        seq: 2,
        timeCreated: baseTime + 1_000,
        timeUpdated: baseTime + 1_000,
        rawData: "{broken",
      });

      const env = {
        ...context.env,
        SMILEWORK_OPENCODE_DB: dbPath,
        SMILEWORK_TRANSCRIPTS_DISABLED_SOURCES: "claude,codex",
      };

      const index = await runCli(["transcripts", "index"], env);
      expect(index.exitCode).toBe(0);
      const report = JSON.parse(index.stdout) as {
        warnings: { source: string; message: string }[];
      };
      expect(
        report.warnings.some(
          (warning) =>
            warning.source === "opencode" &&
            warning.message === "OpenCode 訊息內容不是有效的 JSON",
        ),
      ).toBe(true);

      const status = await runCli(["transcripts", "status"], env);
      expect(status.exitCode).toBe(0);
      expect((JSON.parse(status.stdout) as { warnings: number }).warnings).toBeGreaterThanOrEqual(
        1,
      );
    });
  }, 30_000);

  test("未知子命令以非 0 結束", async () => {
    await withTranscriptEnv("cli-transcripts-unknown", async (context) => {
      const result = await runCli(["transcripts", "no-such-subcommand"], context.env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("未知的 transcripts 子命令");
    });
  }, 30_000);
});
