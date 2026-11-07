import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSafeEnv } from "../../src/shared/process-runner.ts";
import { buildVerificationEnv } from "../../src/verify/environment.ts";
import {
  buildRunnerCommand,
  EXTRA_ARG_FLAG_ALLOWLIST,
  isPackageScriptAllowed,
  isSupportedRunner,
  normalizeScript,
  validateExtraArgs,
  validateGradleArgs,
} from "../../src/verify/runners.ts";
import { withTempDir } from "../helpers/temp.ts";
import {
  findArgumentOutsideProject,
  inspectGradleWrapper,
  resolveProjectRoot,
  resolveWorkingDirectory,
} from "../../src/verify/workspace.ts";

describe("驗證 runner 白名單", () => {
  test("支援 bun、npm、pytest、cargo、gradle、swift", () => {
    for (const runner of ["bun", "npm", "pytest", "cargo", "gradle", "swift"]) {
      expect(isSupportedRunner(runner)).toBe(true);
    }
    for (const runner of ["pnpm", "yarn", "go", "node", "unknown"]) {
      expect(isSupportedRunner(runner)).toBe(false);
    }
  });

  test("套件 runner 只允許驗證用 script family", () => {
    for (const script of [
      "test",
      "test:p0",
      "test:fix",
      "lint",
      "lint:ci",
      "typecheck",
      "check",
      "verify",
      "format:check",
      "format:verify",
    ]) {
      expect({ script, allowed: isPackageScriptAllowed(script) }).toEqual({ script, allowed: true });
    }
    for (const script of ["", "format", "postinstall", "prepare", "build", "start", "deploy"]) {
      expect({ script, allowed: isPackageScriptAllowed(script) }).toEqual({ script, allowed: false });
    }
  });

  test("直接 runner 的 script 只能是空或 test", () => {
    expect(normalizeScript("pytest", "")).toBe("test");
    expect(normalizeScript("pytest", "test")).toBe("test");
    expect(normalizeScript("cargo", "")).toBe("test");
    expect(normalizeScript("gradle", "test")).toBe("test");
    expect(normalizeScript("swift", "tests")).toBeNull();
    expect(normalizeScript("pytest", "pytest -q tests")).toBeNull();
  });

  test("套件 runner 的 script 必填且落在 family", () => {
    expect(normalizeScript("bun", "")).toBeNull();
    expect(normalizeScript("bun", "test:p0")).toBe("test:p0");
    expect(normalizeScript("npm", "lint")).toBe("lint");
    expect(normalizeScript("npm", "format")).toBeNull();
    expect(normalizeScript("bun", "postinstall")).toBeNull();
  });

  test("逐 runner 旗標白名單沿用舊版", () => {
    expect(EXTRA_ARG_FLAG_ALLOWLIST.pytest).toContain("-q");
    expect(EXTRA_ARG_FLAG_ALLOWLIST.pytest).not.toContain("-p");
    expect(EXTRA_ARG_FLAG_ALLOWLIST.cargo).toContain("--manifest-path");
    expect(EXTRA_ARG_FLAG_ALLOWLIST.cargo).toContain("-p");
    expect(EXTRA_ARG_FLAG_ALLOWLIST.swift).toContain("--filter");
    expect(EXTRA_ARG_FLAG_ALLOWLIST.bun).toContain("-t");
    expect(EXTRA_ARG_FLAG_ALLOWLIST.npm).toContain("--testNamePattern");
  });

  test("非白名單旗標會被指出", () => {
    expect(validateExtraArgs("pytest", ["-q", "-k", "recovery"])).toEqual({ ok: true });
    expect(validateExtraArgs("pytest", ["-p", "evil.plugin"])).toMatchObject({
      ok: false,
      rejectedArg: "-p",
    });
    expect(validateExtraArgs("cargo", ["--manifest-path=Cargo.toml"])).toEqual({ ok: true });
    expect(validateExtraArgs("cargo", ["--config", "evil.toml"])).toMatchObject({
      ok: false,
      rejectedArg: "--config",
    });
    expect(validateExtraArgs("bun", ["-t", "recovery"])).toEqual({ ok: true });
    expect(validateExtraArgs("bun", ["--fix"])).toMatchObject({ ok: false, rejectedArg: "--fix" });
    expect(validateExtraArgs("npm", ["--write"])).toMatchObject({ ok: false, rejectedArg: "--write" });
    expect(validateExtraArgs("swift", ["--enable-test-discovery"])).toMatchObject({
      ok: false,
      rejectedArg: "--enable-test-discovery",
    });
    expect(validateExtraArgs("pytest", ["tests/unit/test_a.py", "-k", "recovery"])).toEqual({ ok: true });
  });

  test("Gradle 只允許 test task、--rerun-tasks 與 --tests pattern", () => {
    expect(validateGradleArgs([])).toEqual({ ok: true });
    expect(validateGradleArgs(["--rerun-tasks"])).toEqual({ ok: true });
    expect(validateGradleArgs(["--tests", "com.example.*"])).toEqual({ ok: true });
    expect(validateGradleArgs(["--tests"])).toMatchObject({ ok: false });
    expect(validateGradleArgs(["test"])).toMatchObject({ ok: false, rejectedArg: "test" });
    expect(validateGradleArgs(["--no-daemon"])).toMatchObject({ ok: false, rejectedArg: "--no-daemon" });
  });

  test("六個 runner 的 argv 組裝固定", () => {
    expect(buildRunnerCommand("bun", "test", ["-t", "a"], "/bin/bun")).toEqual([
      "/bin/bun",
      "run",
      "test",
      "-t",
      "a",
    ]);
    expect(buildRunnerCommand("npm", "lint", ["-q"], "/bin/npm")).toEqual([
      "/bin/npm",
      "run",
      "lint",
      "--",
      "-q",
    ]);
    expect(buildRunnerCommand("pytest", "test", ["-q", "tests"], "/bin/pytest")).toEqual([
      "/bin/pytest",
      "-q",
      "tests",
    ]);
    expect(buildRunnerCommand("cargo", "test", ["--offline"], "/bin/cargo")).toEqual([
      "/bin/cargo",
      "test",
      "--offline",
    ]);
    expect(buildRunnerCommand("swift", "test", ["--filter", "A"], "/bin/swift")).toEqual([
      "/bin/swift",
      "test",
      "--filter",
      "A",
    ]);
    expect(buildRunnerCommand("gradle", "test", ["--rerun-tasks"], "/project/gradlew")).toEqual([
      "/project/gradlew",
      "test",
      "--rerun-tasks",
    ]);
  });
});

describe("驗證環境變數", () => {
  test("只保留白名單，並排除 token/secret 類鍵", () => {
    const env = buildVerificationEnv("pytest", {
      PATH: "/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "Asia/Taipei",
      JAVA_HOME: "/opt/java",
      CARGO_HOME: "/tmp/cargo",
      PYTHONPATH: "/tmp/python",
      CI: "0",
      NO_COLOR: "0",
      PYTHONDONTWRITEBYTECODE: "0",
      SMILEWORK_FAKE_TOKEN: "should-not-leak",
      ANTHROPIC_API_KEY: "should-not-leak",
      RANDOM_UNKNOWN: "drop-me",
      TEAM_SECRET: "should-not-leak",
      HTTPS_PROXY: "http://user:pass@proxy.invalid",
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "Asia/Taipei",
      JAVA_HOME: "/opt/java",
      CARGO_HOME: "/tmp/cargo",
      PYTHONPATH: "/tmp/python",
      CI: "1",
      NO_COLOR: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    });
    expect(env.SMILEWORK_FAKE_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.RANDOM_UNKNOWN).toBeUndefined();
    expect(env.TEAM_SECRET).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  test("非 pytest runner 不注入 PYTHONDONTWRITEBYTECODE", () => {
    const env = buildVerificationEnv("bun", { PATH: "/bin", PYTHONDONTWRITEBYTECODE: "0" });
    expect(env.PYTHONDONTWRITEBYTECODE).toBeUndefined();
    expect(env.CI).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });

  test("process-runner 的 buildSafeEnv 與驗證白名單一致", () => {
    const env = buildSafeEnv({ PATH: "/bin", VISIBLE: "yes", SOME_TOKEN: "x" }, ["PATH", "VISIBLE"]);
    expect(env).toEqual({ PATH: "/bin", VISIBLE: "yes" });
  });
});

describe("專案內路徑限制", () => {
  test("工作目錄必須存在且位於專案內", async () => {
    await withTempDir("verify-workspace", async (root) => {
      const project = join(root, "project");
      const inside = join(project, "tests", "unit");
      const outside = join(root, "outside");
      mkdirSync(inside, { recursive: true });
      mkdirSync(outside, { recursive: true });

      expect(resolveProjectRoot(project)).toBe(realpathSync(project));
      expect(resolveWorkingDirectory(project, "tests/unit")).toBe(realpathSync(inside));
      expect(() => resolveWorkingDirectory(project, "../outside")).toThrow();
      expect(() => resolveWorkingDirectory(project, outside)).toThrow();
      expect(() => resolveWorkingDirectory(project, "does-not-exist")).toThrow();
    });
  });

  test("cwd 的 symlink 指到專案外會被拒絕", async () => {
    await withTempDir("verify-workspace-symlink", async (root) => {
      const project = join(root, "project");
      const outside = join(root, "outside");
      mkdirSync(project, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(project, "escape"));

      expect(() => resolveWorkingDirectory(project, "escape")).toThrow();
    });
  });

  test("參數指向專案外的既有路徑會被找出", async () => {
    await withTempDir("verify-args", async (root) => {
      const project = join(root, "project");
      const outside = join(root, "outside");
      mkdirSync(join(project, "tests"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(project, "tests", "test_a.py"), "", "utf8");
      writeFileSync(join(outside, "x.py"), "", "utf8");

      const outsideRelative = join("..", "outside", "x.py");
      expect(findArgumentOutsideProject([outsideRelative], project, project)).toBe(outsideRelative);
      expect(
        findArgumentOutsideProject([`--manifest-path=${join(outside, "x.py")}`], project, project),
      ).toBe(join(outside, "x.py"));
      expect(findArgumentOutsideProject(["tests/test_a.py"], project, project)).toBeNull();
      expect(findArgumentOutsideProject(["not/a/real/path"], project, project)).toBeNull();
      expect(findArgumentOutsideProject(["-k", "recovery"], project, project)).toBeNull();
    });
  });

  test("Gradle wrapper 必須是 cwd 內可執行的普通檔案", async () => {
    await withTempDir("verify-gradle-wrapper", async (root) => {
      const project = join(root, "project");
      mkdirSync(project, { recursive: true });

      expect(inspectGradleWrapper(project)).toMatchObject({ ok: false, code: "GRADLE_WRAPPER_NOT_FOUND" });

      const wrapper = join(project, "gradlew");
      writeFileSync(wrapper, "#!/bin/sh\n", "utf8");
      chmodSync(wrapper, 0o644);
      expect(inspectGradleWrapper(project)).toMatchObject({
        ok: false,
        code: "GRADLE_WRAPPER_NOT_EXECUTABLE",
      });

      chmodSync(wrapper, 0o755);
      expect(inspectGradleWrapper(project)).toEqual({ ok: true, path: realpathSync(wrapper) });

      const linkedProject = join(root, "linked-project");
      const outside = join(root, "outside");
      mkdirSync(linkedProject, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "gradlew"), "#!/bin/sh\n", "utf8");
      chmodSync(join(outside, "gradlew"), 0o755);
      symlinkSync(join(outside, "gradlew"), join(linkedProject, "gradlew"));
      expect(inspectGradleWrapper(linkedProject)).toMatchObject({
        ok: false,
        code: "GRADLE_WRAPPER_INVALID",
      });
    });
  });
});
