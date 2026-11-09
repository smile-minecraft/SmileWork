import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  loadSmileworkConfig,
  PROFILE_TOOL_COUNTS,
  PROFILE_TOOLS,
  profileToolNames,
} from "../../src/mcp/profiles.ts";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../../src/mcp/registry.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempHome } from "../helpers/temp.ts";
import { CURATOR_TOOL_NAMES, WORKER_TOOL_NAMES } from "./helpers.ts";

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("工具 profile 定義", () => {
  test("worker 12 個、curator 15 個、full 21 個，而且名稱精確", () => {
    expect(PROFILE_TOOL_COUNTS).toEqual({ worker: 12, curator: 15, full: 21 });
    expect(PROFILE_TOOLS.worker).toHaveLength(12);
    expect(PROFILE_TOOLS.curator).toHaveLength(15);
    expect(PROFILE_TOOLS.full).toHaveLength(21);
    expect(sorted(PROFILE_TOOLS.worker)).toEqual(sorted(WORKER_TOOL_NAMES));
    expect(sorted(PROFILE_TOOLS.curator)).toEqual(sorted(CURATOR_TOOL_NAMES));
    expect(sorted(PROFILE_TOOLS.full)).toEqual(sorted(TOOL_NAMES));
  });

  test("worker 不含對話紀錄工具，curator 不含建立與修改工作的工具", () => {
    for (const name of ["transcript_search", "transcript_read"]) {
      expect(PROFILE_TOOLS.worker).not.toContain(name);
    }
    for (const name of [
      "work_create",
      "work_update",
      "work_complete",
      "work_review",
      "work_ready",
      "verify_run",
    ]) {
      expect(PROFILE_TOOLS.curator).not.toContain(name);
    }
    expect(PROFILE_TOOLS.curator).toContain("work_get");
    expect(PROFILE_TOOLS.curator).toContain("work_list");
  });

  test("每個 profile 的工具都在 registry 裡，而且 disabledTools 只能縮減", () => {
    const known = new Set(TOOL_NAMES);
    for (const profile of ["worker", "curator", "full"] as const) {
      for (const name of PROFILE_TOOLS[profile]) {
        expect(known.has(name)).toBe(true);
      }
    }
    const narrowed = profileToolNames("full", ["work_create", "not_a_tool"]);
    expect(narrowed).toHaveLength(20);
    expect(narrowed).not.toContain("work_create");
  });

  test("TOOL_DEFINITIONS 的名稱與順序和 TOOL_NAMES 完全相同，PROFILE_TOOLS 都在清單內", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const profile of ["worker", "curator", "full"] as const) {
      for (const name of PROFILE_TOOLS[profile]) {
        expect(TOOL_NAMES).toContain(name);
      }
    }
  });
});

describe("兩層設定檔", () => {
  test("全域提供 profile，專案層只能縮減工具", async () => {
    await withTempHome("mcp-surface-config-merge", async (home, root) => {
      const repo = await createGitRepo(join(root, "repo"));
      await mkdir(home, { recursive: true });
      await writeFile(
        join(home, "config.jsonc"),
        `{
          // 使用者層可以選擇 profile
          "profile": "curator",
          "disabledTools": ["knowledge_read"]
        }\n`,
        "utf8",
      );
      await writeFile(
        join(repo, ".smilework.jsonc"),
        `{
          "profile": "full",
          "disabledTools": ["knowledge_search"],
          "database": "/tmp/evil.db"
        }\n`,
        "utf8",
      );

      const config = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: undefined },
        projectPath: repo,
      });

      expect(config.profile).toBe("curator");
      expect(config.profileSource).toBe("global");
      expect(config.tools).not.toContain("knowledge_read");
      expect(config.tools).not.toContain("knowledge_search");
      expect(config.tools).toContain("knowledge_write");
      expect(config.disabledTools).toEqual(["knowledge_read", "knowledge_search"]);
      expect(config.files.global).toBe(join(home, "config.jsonc"));
      expect(config.files.project).toBe(realpathSync(join(repo, ".smilework.jsonc")));
      expect(config.warnings.join("\n")).toContain("profile");
      expect(config.warnings.join("\n")).toContain("database");
    });
  });

  test("環境變數優先於全域設定，專案層不能提升權限", async () => {
    await withTempHome("mcp-surface-config-precedence", async (home, root) => {
      const repo = await createGitRepo(join(root, "repo"));
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "config.jsonc"), `{"profile": "worker"}\n`, "utf8");
      await writeFile(join(repo, ".smilework.jsonc"), `{"profile": "full"}\n`, "utf8");

      const fromEnv = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: "full" },
        projectPath: repo,
      });
      expect(fromEnv.profile).toBe("full");
      expect(fromEnv.profileSource).toBe("env");
      expect(fromEnv.tools).toHaveLength(21);

      const projectTriesToRaise = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: undefined },
        projectPath: repo,
      });
      expect(projectTriesToRaise.profile).toBe("worker");
      expect(projectTriesToRaise.tools).toHaveLength(12);
      expect(projectTriesToRaise.warnings.join("\n")).toContain("profile");
    });
  });

  test("設定檔格式錯誤時保留其他層，並留下警告", async () => {
    await withTempHome("mcp-surface-config-broken", async (home, root) => {
      const repo = await createGitRepo(join(root, "repo"));
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "config.jsonc"), `{"profile": "curator"}\n`, "utf8");
      await writeFile(join(repo, ".smilework.jsonc"), `{ this is not jsonc\n`, "utf8");

      const config = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: undefined },
        projectPath: repo,
      });

      expect(config.profile).toBe("curator");
      expect(config.tools).toHaveLength(15);
      expect(config.warnings.some((warning) => warning.includes(".smilework.jsonc"))).toBe(true);
    });
  });

  test("沒有設定時預設 worker", async () => {
    await withTempHome("mcp-surface-config-default", async (home, root) => {
      const repo = await createGitRepo(join(root, "repo"));
      const config = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: undefined },
        projectPath: repo,
      });
      expect(config.profile).toBe("worker");
      expect(config.profileSource).toBe("default");
      expect(config.tools).toHaveLength(12);
      expect(config.files).toEqual({ global: null, project: null });
      expect(config.warnings).toEqual([]);
    });
  });

  test("全域 disabledTools 的未知工具名稱留下警告，合法名稱仍停用", async () => {
    await withTempHome("mcp-surface-config-unknown-global", async (home, root) => {
      const repo = await createGitRepo(join(root, "repo"));
      await mkdir(home, { recursive: true });
      await writeFile(
        join(home, "config.jsonc"),
        `{"disabledTools": ["work_create", "not_a_tool"]}\n`,
        "utf8",
      );

      const config = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: undefined },
        projectPath: repo,
      });

      expect(config.tools).not.toContain("work_create");
      expect(config.tools).toHaveLength(11);
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain("全域設定");
      expect(config.warnings[0]).toContain("未知");
      expect(config.warnings[0]).toContain("not_a_tool");
      expect(config.warnings[0]).not.toContain("work_create");
    });
  });

  test("專案 disabledTools 的未知工具名稱也留下警告，合法名稱仍停用", async () => {
    await withTempHome("mcp-surface-config-unknown-project", async (home, root) => {
      const repo = await createGitRepo(join(root, "repo"));
      await writeFile(
        join(repo, ".smilework.jsonc"),
        `{"disabledTools": ["knowledge_read", "knowlege_read"]}\n`,
        "utf8",
      );

      const config = loadSmileworkConfig({
        env: { ...process.env, SMILEWORK_HOME: home, SMILEWORK_PROFILE: undefined },
        projectPath: repo,
      });

      expect(config.tools).not.toContain("knowledge_read");
      expect(config.tools).toHaveLength(11);
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain("專案設定");
      expect(config.warnings[0]).toContain("未知");
      expect(config.warnings[0]).toContain("knowlege_read");
      expect(config.warnings[0]).not.toContain("knowledge_read");
    });
  });
});
