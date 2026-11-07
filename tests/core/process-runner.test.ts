import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSafeEnv, runProcess } from "../../src/shared/process-runner.ts";
import { withTempDir } from "../helpers/temp.ts";

const fixtures = join(import.meta.dir, "..", "helpers", "fixtures");

describe("process-runner", () => {
  test("argv 直啟，特殊字元不被 shell 展開", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [join(fixtures, "argv-echo.ts"), "a b", "$HOME", "*"],
      env: buildSafeEnv(process.env),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["a b", "$HOME", "*"]);
  });

  test("非零退出碼會回報 exitCode，不丟例外", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [join(fixtures, "exit-code.ts"), "7"],
      env: buildSafeEnv(process.env),
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("exit 7");
    expect(result.timedOut).toBe(false);
  });

  test("逾時會終止程序並標記 timedOut", async () => {
    const started = performance.now();
    const result = await runProcess({
      command: process.execPath,
      args: [join(fixtures, "slow-exit.ts"), "5000"],
      env: buildSafeEnv(process.env),
      timeoutMs: 150,
    });
    const elapsed = performance.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(3000);
  });

  test("leader 正常 exit 後不等待背景子程序握著的 pipe", async () => {
    await withTempDir("process-leader-exit", async (dir) => {
      const pidFile = join(dir, "background.pid");
      let backgroundPid: number | null = null;

      try {
        const started = performance.now();
        const result = await runProcess({
          command: "/bin/sh",
          args: [
            "-c",
            'sleep 30 & echo $! > "$1"; echo LEADER_DONE; exit 0',
            "sh",
            pidFile,
          ],
          env: buildSafeEnv(process.env),
          timeoutMs: 1000,
        });
        const elapsed = performance.now() - started;

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("LEADER_DONE");
        expect(result.durationMs).toBeLessThan(1000);
        expect(elapsed).toBeLessThan(1000);

        const parsed = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isInteger(parsed) && parsed > 0) backgroundPid = parsed;
        expect(backgroundPid).not.toBeNull();
        expect(() => process.kill(backgroundPid ?? 0, 0)).not.toThrow();
      } finally {
        try {
          const parsed = Number((await readFile(pidFile, "utf8")).trim());
          if (Number.isInteger(parsed) && parsed > 0) backgroundPid = parsed;
        } catch {
          // 背景程序可能沒有成功啟動。
        }
        if (backgroundPid !== null) {
          try {
            process.kill(backgroundPid, "SIGKILL");
          } catch {
            // 已經結束。
          }
        }
      }
    });
  });

  test("輸出上限會截斷並標記 truncated", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [join(fixtures, "big-output.ts"), "200000"],
      env: buildSafeEnv(process.env),
      maxOutputBytes: 1000,
    });

    expect(result.stdout.length).toBe(1000);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("截斷後保留頭端與尾端 marker", async () => {
    const awk = Bun.which("awk") ?? "/usr/bin/awk";
    const result = await runProcess({
      command: awk,
      args: [
        'BEGIN { printf "HEAD_MARKER\\n"; for (i = 0; i < 20000; i++) printf "0123456789"; printf "\\nTAIL_MARKER\\n" }',
      ],
      env: buildSafeEnv(process.env),
      maxOutputBytes: 2000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.startsWith("HEAD_MARKER")).toBe(true);
    expect(result.stdout.endsWith("TAIL_MARKER\n")).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(2000);
  });

  test("環境變數只包含允許清單中的鍵", async () => {
    const env = buildSafeEnv(
      { PATH: "/bin", HOME: "/tmp/home", SECRET_TOKEN: "do-not-pass", VISIBLE: "yes" },
      ["PATH", "HOME", "VISIBLE"],
    );

    expect(env).toEqual({ PATH: "/bin", HOME: "/tmp/home", VISIBLE: "yes" });
  });
});
