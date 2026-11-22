import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { installStdioStdoutGuard } from "../../src/mcp/stdio-guard.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const guardPath = join(repoRoot, "src/mcp/stdio-guard.ts");
const serverPath = join(repoRoot, "src/mcp/server.ts");

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 stderr 輸出逾時");
    await Bun.sleep(20);
  }
}

describe("MCP stdio stdout 防護", () => {
  test("console 方法改寫到 stderr，restore 後回到原方法", () => {
    const originals = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      dir: console.dir,
      trace: console.trace,
    };
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const originalStderrWrite = process.stderr.write;
    const originalStdoutWrite = process.stdout.write;
    Object.assign(process.stderr, {
      write(chunk: string | Uint8Array): boolean {
        stderrWrites.push(String(chunk));
        return true;
      },
    });
    Object.assign(process.stdout, {
      write(chunk: string | Uint8Array): boolean {
        stdoutWrites.push(String(chunk));
        return true;
      },
    });

    const guard = installStdioStdoutGuard();
    try {
      console.log("NOISE log");
      console.info("NOISE info");
      console.debug("NOISE debug");
      console.warn("NOISE warn");
      console.dir({ noise: "dir" });
      console.trace("NOISE trace");
    } finally {
      guard.restore();
      Object.assign(process.stderr, { write: originalStderrWrite });
      Object.assign(process.stdout, { write: originalStdoutWrite });
    }

    const stderr = stderrWrites.join("");
    expect(stderr).toContain("NOISE log");
    expect(stderr).toContain("NOISE info");
    expect(stderr).toContain("NOISE debug");
    expect(stderr).toContain("NOISE warn");
    expect(stderr).toContain("noise: 'dir'");
    expect(stderr).toContain("NOISE trace");
    expect(stdoutWrites.join("")).not.toContain("NOISE");

    expect(console.log).toBe(originals.log);
    expect(console.info).toBe(originals.info);
    expect(console.debug).toBe(originals.debug);
    expect(console.warn).toBe(originals.warn);
    expect(console.dir).toBe(originals.dir);
    expect(console.trace).toBe(originals.trace);

    guard.restore();
  });

  test("子進程的 stdout 只留下合法的 JSON-RPC frame", async () => {
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const script = [
      `import { installStdioStdoutGuard } from ${JSON.stringify(guardPath)};`,
      "const guard = installStdioStdoutGuard();",
      `process.stdout.write(${JSON.stringify(`${frame}\n`)});`,
      'console.log("NOISE child");',
      'console.warn("NOISE child warn");',
      "guard.restore();",
    ].join("\n");

    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("NOISE child");
    expect(stderr).toContain("NOISE child warn");
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  test("startMcpServer 在 serveStdio 前安裝防護，工具呼叫仍能正常使用", async () => {
    await withTempDir("mcp-stdio-guard", async (root) => {
      const home = join(root, "home", ".smilework");
      const project = await createGitRepo(join(root, "repo"));
      const script = [
        `import { startMcpServer } from ${JSON.stringify(serverPath)};`,
        "setTimeout(() => {",
        '  console.log("NOISE_FROM_SERVER");',
        '  console.info("NOISE_INFO_FROM_SERVER");',
        "}, 25);",
        "await startMcpServer();",
      ].join("\n");

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["-e", script],
        cwd: repoRoot,
        env: {
          ...process.env,
          SMILEWORK_HOME: home,
          SMILEWORK_PROJECT: project,
          SMILEWORK_ACTOR: "test-agent",
          SMILEWORK_MODEL: "test-model",
          SMILEWORK_PROFILE: "full",
        },
        stderr: "pipe",
      });
      const stderrChunks: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(String(chunk)));
      const transportErrors: Error[] = [];
      transport.onerror = (error) => transportErrors.push(error);

      const client = new Client({ name: "smilework-stdio-guard-test", version: "0.0.0" });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.length).toBeGreaterThan(0);
        const called = await client.callTool({ name: "status", arguments: {} });
        expect(called.content.length).toBeGreaterThan(0);

        await waitFor(() => stderrChunks.join("").includes("NOISE_FROM_SERVER"));
        const stderr = stderrChunks.join("");
        expect(stderr).toContain("NOISE_INFO_FROM_SERVER");
        expect(transportErrors).toHaveLength(0);
      } finally {
        await client.close();
      }
    });
  }, 30_000);
});
