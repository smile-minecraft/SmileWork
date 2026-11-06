import { describe, expect, test } from "bun:test";

const repoRoot = `${import.meta.dir}/../..`;
const cliEntry = "src/cli/index.ts";

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

async function runCli(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, output: stdout + stderr, exitCode };
}

describe("CLI 冒煙測試", () => {
  test("--help 以 0 結束並列出所有子命令", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    for (const name of subcommands) {
      expect(result.stdout).toMatch(new RegExp(`^  ${name}\\s`, "m"));
    }
  });

  test("沒有參數時顯示說明", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("用法：");
  });

  test("每個子命令都是可呼叫的掛載點", async () => {
    for (const name of subcommands) {
      const result = await runCli([name]);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("尚未實作");
    }
  }, 30_000);

  test("未知的子命令以非 0 結束並提示", async () => {
    const result = await runCli(["no-such-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("未知的子命令：no-such-command");
  });
});
