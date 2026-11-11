import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, relative } from "node:path";
import { openDatabase } from "../../src/db/index.ts";
import { createToolContext } from "../../src/mcp/context.ts";
import type { ToolContext } from "../../src/mcp/types.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { tool } from "../../src/tools/verify/verify-run.ts";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../../src/verify/run.ts";
import { insertTestWorkItem } from "../helpers/db.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempHome } from "../helpers/temp.ts";

interface EvidenceRow {
  evidence_id: string;
  project_id: string;
  work_id: string;
  kind: string;
  actor: string;
  summary: string;
  command: string | null;
  output: string | null;
  output_path: string | null;
  sha256: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  server_issued: number;
  details: string | null;
}

interface ToolResponse {
  ok: boolean;
  code?: string;
  summary?: string;
  message?: string;
  data?: Record<string, unknown>;
}

interface VerifyFixture {
  home: string;
  root: string;
  project: string;
  fakeBin: string;
  db: Database;
  context: ToolContext;
  projectId: string;
  workId: string;
  install(name: string, body: string): string;
}

async function withVerifyFixture(run: (fixture: VerifyFixture) => Promise<void>): Promise<void> {
  await withTempHome("verify-run", async (home, root) => {
    const project = await createGitRepo(join(root, "project"));
    const db = openDatabase({ home });
    const context = createToolContext({
      env: {
        SMILEWORK_HOME: home,
        SMILEWORK_PROJECT: project,
        SMILEWORK_ACTOR: "test-agent",
        SMILEWORK_MODEL: "test-model",
      },
      cwd: project,
      db,
    });
    const projectContext = context.resolveProject();
    const workId = insertTestWorkItem(db, {
      projectId: projectContext.projectId,
      workId: "work-verify-1",
    });
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });

    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;

    const install = (name: string, body: string): string => {
      const path = join(fakeBin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
      chmodSync(path, 0o755);
      return path;
    };

    try {
      await run({
        home,
        root,
        project,
        fakeBin,
        db,
        context,
        projectId: projectContext.projectId,
        workId,
        install,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      db.close();
    }
  });
}

async function callVerify(
  fixture: VerifyFixture,
  input: Record<string, unknown>,
): Promise<ToolResponse> {
  return (await tool.handler(input, fixture.context)) as ToolResponse;
}

function readEvidenceRow(db: Database, evidenceId: string): EvidenceRow {
  const row = db
    .query<EvidenceRow, [string]>("SELECT * FROM evidence WHERE evidence_id = ?")
    .get(evidenceId);
  if (!row) throw new Error(`evidence not found: ${evidenceId}`);
  return row;
}

function evidenceFile(row: EvidenceRow): string {
  if (!row.output_path) throw new Error("evidence has no output_path");
  return readFileSync(row.output_path, "utf8");
}

describe("verify_run 端到端", () => {
  test("bun 成功執行並寫入 serverIssued 證據", async () => {
    await withVerifyFixture(async (fixture) => {
      const bunPath = fixture.install("bun", [
        'printf "BUN_ARGS:%s\\n" "$*"',
        'printf "TESTS: 3 passed\\n"',
      ].join("\n"));

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "bun",
        script: "test",
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        workId: fixture.workId,
        projectId: fixture.projectId,
        policy: "restricted-verification-v1",
        runner: "bun",
        script: "test",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        passed: true,
        serverIssued: true,
      });
      expect(response.data?.command).toEqual([bunPath, "run", "test"]);
      expect(String(response.data?.stdout)).toContain("BUN_ARGS:run test");
      expect(String(response.data?.stdout)).toContain("TESTS: 3 passed");

      const evidence = response.data?.evidence as {
        evidenceId: string;
        kind: string;
        reportedKind: string;
        summary: string;
        outputPath: string;
        sha256: string;
        exitCode: number | null;
        durationMs: number;
        serverIssued: boolean;
      };
      expect(evidence.serverIssued).toBe(true);
      expect(evidence.kind).toBe("command");
      expect(evidence.reportedKind).toBe("verify_run");
      expect(evidence.summary).toContain("通過");
      expect(evidence.exitCode).toBe(0);
      expect(evidence.durationMs).toBe(Number(response.data?.durationMs));

      const row = readEvidenceRow(fixture.db, evidence.evidenceId);
      expect(row).toMatchObject({
        project_id: fixture.projectId,
        work_id: fixture.workId,
        kind: "command",
        actor: "test-agent",
        exit_code: 0,
        server_issued: 1,
        output: null,
      });
      expect(row.command).toContain("run test");
      expect(row.summary).toContain("通過");
      expect(row.duration_ms).toBe(Number(response.data?.durationMs));
      expect(row.sha256).toBe(evidence.sha256);
      expect(row.output_path).toBe(evidence.outputPath);
      expect(evidence.outputPath.startsWith(join(fixture.home, "evidence"))).toBe(true);
      expect(existsSync(evidence.outputPath)).toBe(true);
      expect(sha256Hex(readFileSync(evidence.outputPath))).toBe(evidence.sha256);
      expect(evidenceFile(row)).toContain("TESTS: 3 passed");
      expect(evidenceFile(row)).toContain("exitCode: 0");

      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details).toMatchObject({
        kind: "verify_run",
        reportedKind: "verify_run",
        tool: "verify_run",
        runner: "bun",
        script: "test",
        passed: true,
        timedOut: false,
        truncated: false,
      });
    });
  });

  test("npm 的 script 與 args 以 -- 轉交", async () => {
    await withVerifyFixture(async (fixture) => {
      const npmPath = fixture.install("npm", 'printf "NPM_ARGS:%s\\n" "$*"');

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "npm",
        script: "lint",
        args: ["-t", "recovery"],
      });

      expect(response.ok).toBe(true);
      expect(response.data?.command).toEqual([npmPath, "run", "lint", "--", "-t", "recovery"]);
      expect(String(response.data?.stdout)).toContain("NPM_ARGS:run lint -- -t recovery");
      const evidence = response.data?.evidence as { evidenceId: string };
      expect(readEvidenceRow(fixture.db, evidence.evidenceId).exit_code).toBe(0);
    });
  });

  test("pytest 省略 script 時執行 pytest + args", async () => {
    await withVerifyFixture(async (fixture) => {
      const pytestPath = fixture.install("pytest", 'printf "PYTEST_ARGS:%s\\n" "$*"');

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        args: ["-q", "tests/unit"],
      });

      expect(response.ok).toBe(true);
      expect(response.data?.script).toBe("test");
      expect(response.data?.command).toEqual([pytestPath, "-q", "tests/unit"]);
      expect(String(response.data?.stdout)).toContain("PYTEST_ARGS:-q tests/unit");
    });
  });

  test("cargo 非零退出碼仍寫入證據", async () => {
    await withVerifyFixture(async (fixture) => {
      const cargoPath = fixture.install("cargo", [
        'printf "CARGO_ARGS:%s\\n" "$*"',
        'printf "failure detail\\n" >&2',
        "exit 7",
      ].join("\n"));

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "cargo",
        args: ["tests/unit"],
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ runner: "cargo", exitCode: 7, passed: false });
      expect(response.data?.command).toEqual([cargoPath, "test", "tests/unit"]);
      expect(response.data?.hint).toBeNull();
      expect(String(response.data?.stderr)).toContain("failure detail");

      const evidence = response.data?.evidence as { evidenceId: string; summary: string };
      expect(evidence.summary).toContain("失敗");
      const row = readEvidenceRow(fixture.db, evidence.evidenceId);
      expect(row.exit_code).toBe(7);
      expect(row.summary).toContain("失敗");
      expect(evidenceFile(row)).toContain("failure detail");
    });
  });

  test("swift 輸出超過上限時截斷並標記", async () => {
    await withVerifyFixture(async (fixture) => {
      const swiftPath = fixture.install("swift", [
        'printf "SWIFT_START\\n"',
        "awk 'BEGIN { for (i = 0; i < 30000; i++) print \"0123456789\" }'",
      ].join("\n"));

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "swift",
      });

      expect(response.ok).toBe(true);
      expect(response.data?.command).toEqual([swiftPath, "test"]);
      expect(response.data?.truncated).toBe(true);
      expect(String(response.data?.stdout).startsWith("SWIFT_START")).toBe(true);
      expect(Buffer.byteLength(String(response.data?.stdout), "utf8")).toBeLessThanOrEqual(
        DEFAULT_MAX_OUTPUT_BYTES,
      );

      const evidence = response.data?.evidence as { evidenceId: string };
      const row = readEvidenceRow(fixture.db, evidence.evidenceId);
      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details.truncated).toBe(true);
      const output = evidenceFile(row);
      expect(output).toContain("truncated: true");
      expect(Buffer.byteLength(output, "utf8")).toBeLessThan(DEFAULT_MAX_OUTPUT_BYTES + 10_000);
    });
  });

  test("swift 因工具鏈不一致失敗時回傳 hint 並寫進證據", async () => {
    await withVerifyFixture(async (fixture) => {
      fixture.install("swift", [
        'printf "error: demo: Invalid manifest (compiled with swiftc)\\n" >&2',
        'printf "Undefined symbols for architecture arm64:\\n" >&2',
        'printf "  PackageDescription.Package.__allocating_init\\n" >&2',
        "exit 1",
      ].join("\n"));

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "swift",
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ runner: "swift", exitCode: 1, passed: false });
      const hint = String(response.data?.hint);
      expect(hint).toContain("工具鏈");
      expect(hint).toContain("xcode-select -p");
      expect(hint).toContain("swift --version");
      expect(hint).toContain("xcrun --find swift");
      expect(hint).toContain("DEVELOPER_DIR");

      const evidence = response.data?.evidence as { evidenceId: string; summary: string };
      expect(evidence.summary).toContain("工具鏈可能不一致");
      const row = readEvidenceRow(fixture.db, evidence.evidenceId);
      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details.hint).toBe(hint);
      expect(evidenceFile(row)).toContain(hint);
    });
  });

  test("swift 通過時不產生 hint", async () => {
    await withVerifyFixture(async (fixture) => {
      fixture.install("swift", 'printf "PackageDescription\\n"');

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "swift",
      });

      expect(response.ok).toBe(true);
      expect(response.data?.passed).toBe(true);
      expect(response.data?.hint).toBeNull();
    });
  });

  test("gradle 使用 cwd 內的 gradlew 並限制參數", async () => {
    await withVerifyFixture(async (fixture) => {
      const wrapper = join(fixture.project, "gradlew");
      writeFileSync(wrapper, '#!/bin/sh\nprintf "GRADLE_ARGS:%s\\n" "$*"\n', "utf8");
      chmodSync(wrapper, 0o755);

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "gradle",
        args: ["--rerun-tasks", "--tests", "com.example.*"],
      });

      expect(response.ok).toBe(true);
      expect(response.data?.command).toEqual([
        realpathSync(wrapper),
        "test",
        "--rerun-tasks",
        "--tests",
        "com.example.*",
      ]);
      expect(String(response.data?.stdout)).toContain(
        "GRADLE_ARGS:test --rerun-tasks --tests com.example.*",
      );
    });
  });
});

describe("verify_run 拒絕不在白名單的輸入", () => {
  test("套件 runner 的非白名單旗標回 ARGS_NOT_ALLOWED 且不執行", async () => {
    await withVerifyFixture(async (fixture) => {
      const marker = join(fixture.root, "bun-ran");
      fixture.install("bun", `touch "${marker}"`);

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "bun",
        script: "test",
        args: ["--fix"],
      });

      expect(response.ok).toBe(false);
      expect(response.code).toBe("ARGS_NOT_ALLOWED");
      expect(response.data).toMatchObject({ rejectedArg: "--fix", runner: "bun" });
      expect(existsSync(marker)).toBe(false);
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM evidence").get()).toEqual({ count: 0 });
    });
  });

  test("pytest 的 -p 與 gradle 的額外 task 都被拒絕", async () => {
    await withVerifyFixture(async (fixture) => {
      const pytestMarker = join(fixture.root, "pytest-ran");
      const gradleMarker = join(fixture.root, "gradle-ran");
      fixture.install("pytest", `touch "${pytestMarker}"`);
      const wrapper = join(fixture.project, "gradlew");
      writeFileSync(wrapper, `#!/bin/sh\ntouch "${gradleMarker}"\n`, "utf8");
      chmodSync(wrapper, 0o755);

      const pytest = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        args: ["-p", "evil.plugin"],
      });
      expect(pytest.ok).toBe(false);
      expect(pytest.code).toBe("ARGS_NOT_ALLOWED");
      expect(pytest.data).toMatchObject({ rejectedArg: "-p" });

      const gradle = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "gradle",
        args: ["--no-daemon"],
      });
      expect(gradle.ok).toBe(false);
      expect(gradle.code).toBe("ARGS_NOT_ALLOWED");
      expect(gradle.data).toMatchObject({ rejectedArg: "--no-daemon" });

      expect(existsSync(pytestMarker)).toBe(false);
      expect(existsSync(gradleMarker)).toBe(false);
    });
  });

  test("lifecycle script 與直接 runner 的非法 script 回 SCRIPT_NOT_ALLOWED", async () => {
    await withVerifyFixture(async (fixture) => {
      fixture.install("bun", 'printf "BUN\\n"');
      fixture.install("pytest", 'printf "PYTEST\\n"');

      const lifecycle = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "bun",
        script: "postinstall",
      });
      expect(lifecycle.ok).toBe(false);
      expect(lifecycle.code).toBe("SCRIPT_NOT_ALLOWED");

      const direct = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        script: "pytest -q tests",
      });
      expect(direct.ok).toBe(false);
      expect(direct.code).toBe("SCRIPT_NOT_ALLOWED");
    });
  });

  test("cwd 指向專案外或經 symlink 逃逸都被拒絕", async () => {
    await withVerifyFixture(async (fixture) => {
      const marker = join(fixture.root, "pytest-ran");
      fixture.install("pytest", `touch "${marker}"`);
      const outside = join(fixture.root, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(fixture.project, "escape"));

      const relativeOutside = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        cwd: relative(fixture.project, outside),
      });
      expect(relativeOutside.ok).toBe(false);
      expect(relativeOutside.code).toBe("INVALID_CWD");

      const absoluteOutside = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        cwd: outside,
      });
      expect(absoluteOutside.ok).toBe(false);
      expect(absoluteOutside.code).toBe("INVALID_CWD");

      const symlinkEscape = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        cwd: "escape",
      });
      expect(symlinkEscape.ok).toBe(false);
      expect(symlinkEscape.code).toBe("INVALID_CWD");
      expect(existsSync(marker)).toBe(false);
    });
  });

  test("參數指向專案外既有路徑被拒絕", async () => {
    await withVerifyFixture(async (fixture) => {
      const marker = join(fixture.root, "pytest-ran");
      fixture.install("pytest", `touch "${marker}"`);
      fixture.install("cargo", `touch "${marker}"`);
      const outside = join(fixture.root, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "x.py"), "", "utf8");
      writeFileSync(join(outside, "Cargo.toml"), "", "utf8");

      const positional = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        args: [relative(fixture.project, join(outside, "x.py"))],
      });
      expect(positional.ok).toBe(false);
      expect(positional.code).toBe("ARG_PATH_OUTSIDE_PROJECT");

      const flagValue = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "cargo",
        args: ["--manifest-path", join(outside, "Cargo.toml")],
      });
      expect(flagValue.ok).toBe(false);
      expect(flagValue.code).toBe("ARG_PATH_OUTSIDE_PROJECT");

      const flagEquals = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "cargo",
        args: [`--manifest-path=${join(outside, "Cargo.toml")}`],
      });
      expect(flagEquals.ok).toBe(false);
      expect(flagEquals.code).toBe("ARG_PATH_OUTSIDE_PROJECT");
      expect(existsSync(marker)).toBe(false);
    });
  });

  test("工作不存在時回 NOT_FOUND 且不執行", async () => {
    await withVerifyFixture(async (fixture) => {
      const marker = join(fixture.root, "pytest-ran");
      fixture.install("pytest", `touch "${marker}"`);

      const response = await callVerify(fixture, {
        workId: "work-missing",
        runner: "pytest",
      });

      expect(response.ok).toBe(false);
      expect(response.code).toBe("NOT_FOUND");
      expect(existsSync(marker)).toBe(false);
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM evidence").get()).toEqual({ count: 0 });
    });
  });

  test("workItemId 可作為 workId 的別名；兩者都沒有時回 INVALID_INPUT", async () => {
    await withVerifyFixture(async (fixture) => {
      fixture.install("pytest", 'printf "OK\\n"');

      const alias = await callVerify(fixture, {
        workItemId: fixture.workId,
        runner: "pytest",
      });
      expect(alias.ok).toBe(true);
      expect(alias.data?.evidence).toMatchObject({ reportedKind: "verify_run" });

      const missing = await callVerify(fixture, { runner: "pytest" });
      expect(missing.ok).toBe(false);
      expect(missing.code).toBe("INVALID_INPUT");
    });
  });
});

describe("verify_run 的執行邊界", () => {
  test("逾時會終止程序、回傳部分輸出並寫入證據", async () => {
    await withVerifyFixture(async (fixture) => {
      // 用外部的 /bin/echo 確保被 SIGKILL 前的輸出已經寫進 pipe；
      // shell 內建的 printf 在 pipe 上可能還在緩衝區。
      fixture.install("pytest", [
        "/bin/echo PARTIAL_BEFORE_TIMEOUT",
        "sleep 5",
        "/bin/echo AFTER_TIMEOUT",
      ].join("\n"));

      const started = performance.now();
      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        timeoutMs: 1000,
      });
      const elapsed = performance.now() - started;

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ timedOut: true, exitCode: null, passed: false });
      expect(String(response.data?.stdout)).toContain("PARTIAL_BEFORE_TIMEOUT");
      expect(String(response.data?.stdout)).not.toContain("AFTER_TIMEOUT");
      expect(elapsed).toBeLessThan(5000);

      const evidence = response.data?.evidence as { evidenceId: string };
      const row = readEvidenceRow(fixture.db, evidence.evidenceId);
      expect(row.exit_code).toBeNull();
      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details.timedOut).toBe(true);
      expect(evidenceFile(row)).toContain("timedOut: true");
    });
  });

  test("環境變數只帶白名單，token 不會出現在輸出或證據", async () => {
    await withVerifyFixture(async (fixture) => {
      const token = "{{SECRET_5b9k2v7m}}";
      const secret = "{{SECRET_9j4x1q8n}}";
      const previousToken = process.env.SMILEWORK_FAKE_TOKEN;
      const previousSecret = process.env.ANTHROPIC_API_KEY;
      process.env.SMILEWORK_FAKE_TOKEN = token;
      process.env.ANTHROPIC_API_KEY = secret;
      try {
        fixture.install("pytest", [
          'printf "CI:%s\\n" "$CI"',
          'printf "NO_COLOR:%s\\n" "$NO_COLOR"',
          'printf "PYTHONDONTWRITEBYTECODE:%s\\n" "$PYTHONDONTWRITEBYTECODE"',
          'printf "FAKE_TOKEN:%s\\n" "$SMILEWORK_FAKE_TOKEN"',
          'printf "API_KEY:%s\\n" "$ANTHROPIC_API_KEY"',
        ].join("\n"));

        const response = await callVerify(fixture, {
          workId: fixture.workId,
          runner: "pytest",
        });

        expect(response.ok).toBe(true);
        const stdout = String(response.data?.stdout);
        expect(stdout).toContain("CI:1");
        expect(stdout).toContain("NO_COLOR:1");
        expect(stdout).toContain("PYTHONDONTWRITEBYTECODE:1");
        expect(stdout).toContain("FAKE_TOKEN:\n");
        expect(stdout).toContain("API_KEY:\n");
        expect(stdout).not.toContain(token);
        expect(stdout).not.toContain(secret);

        const evidence = response.data?.evidence as { evidenceId: string };
        const row = readEvidenceRow(fixture.db, evidence.evidenceId);
        const output = evidenceFile(row);
        expect(output).not.toContain(token);
        expect(output).not.toContain(secret);
      } finally {
        if (previousToken === undefined) delete process.env.SMILEWORK_FAKE_TOKEN;
        else process.env.SMILEWORK_FAKE_TOKEN = previousToken;
        if (previousSecret === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousSecret;
      }
    });
  });

  test("逾時與輸出上限都會套用硬上限", async () => {
    await withVerifyFixture(async (fixture) => {
      fixture.install("swift", 'printf "OK\\n"');

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "swift",
        timeoutMs: 9_999_999,
      });

      expect(response.ok).toBe(true);
      expect(response.data?.timeoutMs).toBe(600_000);
      expect(response.data?.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    });
  });

  test("專案內的 cwd 會被接受並以正規化路徑執行", async () => {
    await withVerifyFixture(async (fixture) => {
      const unit = join(fixture.project, "tests", "unit");
      mkdirSync(unit, { recursive: true });
      fixture.install("pytest", 'printf "PWD:%s\\n" "$PWD"');

      const response = await callVerify(fixture, {
        workId: fixture.workId,
        runner: "pytest",
        cwd: "tests/unit",
      });

      expect(response.ok).toBe(true);
      expect(response.data?.cwd).toBe(realpathSync(unit));
      expect(String(response.data?.stdout)).toContain(realpathSync(unit));
    });
  });
});
