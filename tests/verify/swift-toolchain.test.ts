import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildVerificationEnv } from "../../src/verify/environment.ts";
import {
  MACOS_SWIFT_STUB_PATH,
  resolveSwiftToolchain,
  runVerification,
  shouldResolveSwiftWithXcrun,
  swiftToolchainHint,
} from "../../src/verify/run.ts";
import { withTempDir } from "../helpers/temp.ts";

const DARWIN = "darwin";
const TOOLCHAIN_ENV = buildVerificationEnv("swift", { PATH: "/usr/bin:/bin" });

/** 在暫存目錄放入一支可執行的假工具，回傳它的路徑。 */
function installExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("shouldResolveSwiftWithXcrun", () => {
  test("只有 macOS 的系統 stub 需要改用 xcrun", () => {
    expect(shouldResolveSwiftWithXcrun(DARWIN, MACOS_SWIFT_STUB_PATH)).toBe(true);
    expect(shouldResolveSwiftWithXcrun("linux", MACOS_SWIFT_STUB_PATH)).toBe(false);
    expect(shouldResolveSwiftWithXcrun("win32", MACOS_SWIFT_STUB_PATH)).toBe(false);
    expect(shouldResolveSwiftWithXcrun(DARWIN, "/opt/homebrew/bin/swift")).toBe(false);
    expect(shouldResolveSwiftWithXcrun(DARWIN, "/usr/bin/swiftc")).toBe(false);
    expect(shouldResolveSwiftWithXcrun(DARWIN, `${MACOS_SWIFT_STUB_PATH}.real`)).toBe(false);
  });
});

describe("resolveSwiftToolchain", () => {
  test("PATH 是系統 stub 時回傳 xcrun 解析出的絕對路徑", async () => {
    await withTempDir("swift-toolchain", async (dir) => {
      const toolchainSwift = installExecutable(dir, "toolchain-swift", 'printf "TOOLCHAIN\\n"');
      const xcrunLog = join(dir, "xcrun.log");
      const xcrun = installExecutable(
        dir,
        "xcrun",
        [`printf "%s\\n" "$*" >> "${xcrunLog}"`, `printf "%s\\n" "${toolchainSwift}"`].join("\n"),
      );

      const resolved = await resolveSwiftToolchain(MACOS_SWIFT_STUB_PATH, {
        env: TOOLCHAIN_ENV,
        platform: DARWIN,
        xcrunPath: xcrun,
        realPath: () => MACOS_SWIFT_STUB_PATH,
      });

      expect(resolved).toBe(toolchainSwift);
      expect(readFileSync(xcrunLog, "utf8").trim()).toBe("--find swift");
    });
  });

  test("PATH 上是自訂 swift 時不呼叫 xcrun，路徑保持原樣", async () => {
    await withTempDir("swift-toolchain", async (dir) => {
      const customSwift = installExecutable(dir, "swift", 'printf "CUSTOM\\n"');
      const xcrunMarker = join(dir, "xcrun-ran");
      const xcrun = installExecutable(dir, "xcrun", `touch "${xcrunMarker}"`);

      const resolved = await resolveSwiftToolchain(customSwift, {
        env: TOOLCHAIN_ENV,
        platform: DARWIN,
        xcrunPath: xcrun,
        realPath: (path) => path,
      });

      expect(resolved).toBe(customSwift);
      expect(existsSync(xcrunMarker)).toBe(false);
    });
  });

  test("xcrun 失敗或候選無效時安靜退回 PATH 的 swift", async () => {
    await withTempDir("swift-toolchain", async (dir) => {
      const notExecutable = join(dir, "plain-swift");
      writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", "utf8");
      const bodies = [
        'printf "xcrun failed\\n" >&2\nexit 1',
        'printf "\\n"',
        'printf "usr/bin/swift\\n"',
        `printf "%s\\n" "${join(dir, "missing", "swift")}"`,
        `printf "%s\\n" "${notExecutable}"`,
      ];

      for (const [index, body] of bodies.entries()) {
        const xcrun = installExecutable(dir, `xcrun-${index}`, body);
        const resolved = await resolveSwiftToolchain(MACOS_SWIFT_STUB_PATH, {
          env: TOOLCHAIN_ENV,
          platform: DARWIN,
          xcrunPath: xcrun,
          realPath: () => MACOS_SWIFT_STUB_PATH,
        });
        expect(resolved).toBe(MACOS_SWIFT_STUB_PATH);
      }

      const missingXcrun = await resolveSwiftToolchain(MACOS_SWIFT_STUB_PATH, {
        env: TOOLCHAIN_ENV,
        platform: DARWIN,
        xcrunPath: join(dir, "missing-xcrun"),
        realPath: () => MACOS_SWIFT_STUB_PATH,
      });
      expect(missingXcrun).toBe(MACOS_SWIFT_STUB_PATH);

      const unresolvedRealPath = await resolveSwiftToolchain(MACOS_SWIFT_STUB_PATH, {
        env: TOOLCHAIN_ENV,
        platform: DARWIN,
        xcrunPath: join(dir, "missing-xcrun"),
        realPath: () => null,
      });
      expect(unresolvedRealPath).toBe(MACOS_SWIFT_STUB_PATH);
    });
  });

  test("xcrun 使用受限環境，不帶白名單外的變數", async () => {
    await withTempDir("swift-toolchain", async (dir) => {
      const toolchainSwift = installExecutable(dir, "toolchain-swift", 'printf "TOOLCHAIN\\n"');
      const envLog = join(dir, "env.log");
      const xcrun = installExecutable(
        dir,
        "xcrun",
        [
          `printf "%s\\n" "$SMILEWORK_PROBE_TOKEN" > "${envLog}"`,
          `printf "%s\\n" "${toolchainSwift}"`,
        ].join("\n"),
      );
      const env = buildVerificationEnv("swift", {
        PATH: "/usr/bin:/bin",
        SMILEWORK_PROBE_TOKEN: "swift-probe-secret",
      });

      const resolved = await resolveSwiftToolchain(MACOS_SWIFT_STUB_PATH, {
        env,
        platform: DARWIN,
        xcrunPath: xcrun,
        realPath: () => MACOS_SWIFT_STUB_PATH,
      });

      expect(resolved).toBe(toolchainSwift);
      expect(readFileSync(envLog, "utf8")).not.toContain("swift-probe-secret");
    });
  });
});

describe("runVerification 的 swift 執行檔解析", () => {
  /** PATH 上的 swift 以 symlink 指回系統 stub，讓 realpath 與真機一致。 */
  async function withStubPath(run: (dir: string, fakeBin: string) => Promise<void>): Promise<void> {
    await withTempDir("swift-runner", async (dir) => {
      const fakeBin = join(dir, "fake-bin");
      mkdirSync(fakeBin, { recursive: true });
      symlinkSync(MACOS_SWIFT_STUB_PATH, join(fakeBin, "swift"));
      await run(dir, fakeBin);
    });
  }

  test.skipIf(process.platform !== "darwin")(
    "PATH 的 swift 是系統 stub 時，command[0] 是 xcrun 解析出的絕對路徑",
    async () => {
      await withStubPath(async (dir, fakeBin) => {
        const toolchainSwift = installExecutable(dir, "toolchain-swift", 'printf "TOOLCHAIN_RUN\\n"');
        const xcrun = installExecutable(dir, "xcrun", `printf "%s\\n" "${toolchainSwift}"`);
        const project = join(dir, "project");
        mkdirSync(project, { recursive: true });

        const result = await runVerification({
          projectRoot: project,
          runner: "swift",
          env: { PATH: `${fakeBin}:/usr/bin:/bin` },
          swiftToolchain: { platform: DARWIN, xcrunPath: xcrun },
        });

        expect(result.command).toEqual([toolchainSwift, "test"]);
        expect(result.stdout).toContain("TOOLCHAIN_RUN");
        expect(result.passed).toBe(true);
        expect(result.hint).toBeNull();
      });
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "xcrun 失敗時改用 PATH 上的 swift，不讓驗證因此失敗",
    async () => {
      await withStubPath(async (dir, fakeBin) => {
        const xcrun = installExecutable(dir, "xcrun", 'printf "xcrun failed\\n" >&2\nexit 1');
        const project = join(dir, "project");
        mkdirSync(project, { recursive: true });

        const result = await runVerification({
          projectRoot: project,
          runner: "swift",
          env: { PATH: `${fakeBin}:/usr/bin:/bin` },
          swiftToolchain: { platform: DARWIN, xcrunPath: xcrun },
        });

        expect(result.command).toEqual([join(fakeBin, "swift"), "test"]);
      });
    },
  );
});

describe("swiftToolchainHint", () => {
  const expectedText = [
    "工具鏈",
    "xcode-select -p",
    "swift --version",
    "xcrun --find swift",
    "DEVELOPER_DIR",
  ] as const;

  function expectHint(stdout: string, stderr: string): void {
    const hint = swiftToolchainHint("swift", false, stdout, stderr);
    expect(hint).not.toBeNull();
    for (const text of expectedText) expect(hint).toContain(text);
  }

  test("Invalid manifest 單獨出現時給出可檢查的指令", () => {
    expectHint("", "error: 'demo': Invalid manifest (compiled with swiftc)");
    expectHint("Invalid manifest", "");
  });

  test("Undefined symbols 與 PackageDescription 同時出現時給出提示", () => {
    expectHint(
      "",
      "Undefined symbols for architecture arm64:\n  PackageDescription.Package.__allocating_init",
    );
    // 兩個特徵分散在 stdout 與 stderr 也算同時出現。
    expectHint("PackageDescription.Package.__allocating_init", "Undefined symbols for architecture arm64");
  });

  test("只有 PackageDescription 時不誤報", () => {
    expect(
      swiftToolchainHint("swift", false, "", "error: PackageDescription.Package has no member foo"),
    ).toBeNull();
  });

  test("只有 Undefined symbols 時不誤報", () => {
    expect(swiftToolchainHint("swift", false, "Undefined symbols for architecture arm64", "")).toBeNull();
  });

  test("通過、其他 runner 或無關的失敗不產生提示", () => {
    expect(swiftToolchainHint("swift", true, "Invalid manifest", "")).toBeNull();
    expect(swiftToolchainHint("cargo", false, "Invalid manifest", "")).toBeNull();
    expect(swiftToolchainHint("swift", false, "error: no tests found", "")).toBeNull();
  });
});
