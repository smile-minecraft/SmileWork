import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db/index.ts";
import { runTool } from "../../src/mcp/result.ts";
import { inspectStatus } from "../../src/status/index.ts";
import { tool } from "../../src/tools/status/status.ts";
import { SERVER_NAME, SERVER_VERSION } from "../../src/shared/version.ts";
import { createGitRepo } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

interface StatusHome {
  root: string;
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
}

async function withStatusHome<T>(
  prefix: string,
  run: (context: StatusHome) => T | Promise<T>,
): Promise<T> {
  return withTempDir(prefix, async (root) => {
    const home = join(root, "smilework-home");
    const userHome = join(root, "user-home");
    mkdirSync(home, { recursive: true });
    mkdirSync(userHome, { recursive: true });
    return run({
      root,
      home,
      userHome,
      env: { HOME: userHome, SMILEWORK_HOME: home },
    });
  });
}

function skillSource(userHome: string, name: string): string {
  const path = join(userHome, ".agents", "skills", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `# ${name}\n`, "utf8");
  return path;
}

function skillsLinkDir(userHome: string): string {
  const path = join(userHome, ".claude", "skills");
  mkdirSync(path, { recursive: true });
  return path;
}

describe("健康狀態", () => {
  test("資料庫存在且可查時回報版本、資料庫健康與 schema 版本", async () => {
    await withStatusHome("status-db-ok", async ({ env, home, root }) => {
      const db = openDatabase({ path: join(home, "smilework.db") });
      db.close();

      const report = inspectStatus({ env, cwd: root });

      expect(report.version).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
      expect(report.database).toMatchObject({
        path: join(home, "smilework.db"),
        exists: true,
        status: "ok",
      });
      expect(report.database.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(report.database.sizeBytes).toBeGreaterThan(0);
      expect(report.database.error).toBeNull();
    });
  });

  test("資料庫不存在時回 warning，不拋錯也不建立資料庫", async () => {
    await withStatusHome("status-db-missing", async ({ env, home, root }) => {
      const report = inspectStatus({ env, cwd: root });

      expect(report.database).toMatchObject({ exists: false, status: "missing" });
      expect(report.database.schemaVersion).toBeNull();
      expect(report.warnings.some((warning) => warning.includes("資料庫尚未建立"))).toBe(true);
      expect(existsSync(join(home, "smilework.db"))).toBe(false);
    });
  });

  test("只設定 HOME 時資料庫與索引仍落在該 home 下", async () => {
    await withStatusHome("status-home-only", async ({ userHome, root }) => {
      const report = inspectStatus({ env: { HOME: userHome }, cwd: root });

      expect(report.database.path).toBe(join(userHome, ".smilework", "smilework.db"));
      expect(report.transcripts.path).toBe(join(userHome, ".smilework", "transcripts.db"));
      expect(report.database.status).toBe("missing");
    });
  });

  test("資料庫檔案損壞時回 unavailable 與 warning，不拋錯", async () => {
    await withStatusHome("status-db-broken", async ({ env, home, root }) => {
      writeFileSync(join(home, "smilework.db"), "這不是 SQLite 資料庫", "utf8");

      const report = inspectStatus({ env, cwd: root });

      expect(report.database).toMatchObject({ exists: true, status: "unavailable" });
      expect(report.database.error).not.toBeNull();
      expect(report.warnings.some((warning) => warning.includes("資料庫無法讀取"))).toBe(true);
    });
  });

  test("專案可解析時回報 projectId 與路徑", async () => {
    await withStatusHome("status-project-ok", async ({ env, root }) => {
      const repo = await createGitRepo(join(root, "repo"));

      const report = inspectStatus({ env, cwd: repo });

      expect(report.project).toMatchObject({
        status: "resolved",
        rootPath: realpathSync(repo),
        worktreePath: realpathSync(repo),
        code: null,
        reason: null,
      });
      expect(report.project.projectId).toMatch(/^[0-9a-f]{16}$/);
      expect(report.project.commonDir).not.toBeNull();
    });
  });

  test("非 git 目錄以路徑專案解析", async () => {
    await withStatusHome("status-project-path", async ({ env, root }) => {
      const plain = join(root, "plain");
      mkdirSync(plain, { recursive: true });

      const report = inspectStatus({ env, cwd: plain });

      expect(report.project.status).toBe("resolved");
      expect(report.project.projectId).toMatch(/^[0-9a-f]{16}$/);
      expect(report.project.commonDir).toBe(`path:${realpathSync(plain)}`);
    });
  });

  test("專案無法解析時回 unresolved 與 warning，不讓 status 失敗", async () => {
    await withStatusHome("status-project-missing", async ({ env, root }) => {
      const plain = join(root, "plain");
      mkdirSync(plain, { recursive: true });

      const report = inspectStatus({
        env: { ...env, SMILEWORK_PROJECT: join(root, "missing") },
        cwd: plain,
      });

      expect(report.project).toMatchObject({
        status: "unresolved",
        projectId: null,
        code: "PROJECT_NOT_FOUND",
      });
      expect(report.project.reason).toContain("找不到專案目錄");
      expect(report.warnings.some((warning) => warning.includes("專案無法解析"))).toBe(true);
    });
  });

  test("actor 與 profile 依環境變數顯示", async () => {
    await withStatusHome("status-actor", async ({ env, root }) => {
      const report = inspectStatus({
        env: {
          ...env,
          SMILEWORK_ACTOR: "build",
          SMILEWORK_MODEL: "test-model",
          SMILEWORK_PROFILE: "curator",
        },
        cwd: root,
      });

      expect(report.actor).toMatchObject({
        name: "build",
        model: "test-model",
        declared: true,
        hint: null,
      });
      expect(report.profile).toEqual({ name: "curator", configured: true });
    });
  });

  test("actor 預設 unknown、profile 預設 worker", async () => {
    await withStatusHome("status-defaults", async ({ env, root }) => {
      const report = inspectStatus({ env, cwd: root });

      expect(report.actor).toMatchObject({
        name: "unknown",
        model: "unknown",
        declared: false,
      });
      expect(report.actor.hint).toContain("SMILEWORK_ACTOR");
      expect(report.profile).toEqual({ name: "worker", configured: false });
      expect(report.warnings.some((warning) => warning.includes("SMILEWORK_ACTOR"))).toBe(true);
    });
  });

  test("全域設定檔的 profile 被採用，並標示 configured", async () => {
    await withStatusHome("status-profile-global", async ({ env, home, root }) => {
      writeFileSync(join(home, "config.jsonc"), `{"profile": "full"}\n`, "utf8");

      const report = inspectStatus({ env, cwd: root });

      expect(report.profile).toEqual({ name: "full", configured: true });
    });
  });

  test("SMILEWORK_PROFILE 優先於全域設定檔的 profile", async () => {
    await withStatusHome("status-profile-precedence", async ({ env, home, root }) => {
      writeFileSync(join(home, "config.jsonc"), `{"profile": "full"}\n`, "utf8");

      const report = inspectStatus({
        env: { ...env, SMILEWORK_PROFILE: "curator" },
        cwd: root,
      });

      expect(report.profile).toEqual({ name: "curator", configured: true });
    });
  });

  test("全域設定檔的 profile 無效時使用預設值並留下 warning", async () => {
    await withStatusHome("status-profile-invalid", async ({ env, home, root }) => {
      writeFileSync(join(home, "config.jsonc"), `{"profile": "bogus"}\n`, "utf8");

      const report = inspectStatus({ env, cwd: root });

      expect(report.profile).toEqual({ name: "worker", configured: false });
      expect(
        report.warnings.some(
          (warning) => warning.includes("profile") && warning.includes("bogus"),
        ),
      ).toBe(true);
    });
  });

  test("技能來源與連結目錄都不存在時標示未啟用", async () => {
    await withStatusHome("status-skills-none", async ({ env, root }) => {
      const report = inspectStatus({ env, cwd: root });

      expect(report.skills.status).toBe("not_configured");
      expect(report.skills.source.exists).toBe(false);
      expect(report.skills.links.exists).toBe(false);
    });
  });

  test("技能來源存在但連結目錄不存在時標示 not_linked", async () => {
    await withStatusHome("status-skills-missing-link", async ({ env, userHome, root }) => {
      skillSource(userHome, "alpha");

      const report = inspectStatus({ env, cwd: root });

      expect(report.skills.status).toBe("not_linked");
      expect(report.skills.source).toMatchObject({ exists: true, skills: ["alpha"] });
      expect(report.skills.links).toMatchObject({ exists: false, symlinks: [], broken: [] });
      expect(report.warnings.some((warning) => warning.includes("尚未連結"))).toBe(true);
    });
  });

  test("技能 symlink 有效時標示 linked", async () => {
    await withStatusHome("status-skills-linked", async ({ env, userHome, root }) => {
      const source = skillSource(userHome, "alpha");
      const linkDir = skillsLinkDir(userHome);
      symlinkSync(source, join(linkDir, "alpha"));

      const report = inspectStatus({ env, cwd: root });

      expect(report.skills.status).toBe("linked");
      expect(report.skills.links).toMatchObject({
        exists: true,
        symlinks: ["alpha"],
        broken: [],
        missing: [],
      });
    });
  });

  test("技能 symlink 斷鏈時標示 broken 與 warning", async () => {
    await withStatusHome("status-skills-broken", async ({ env, userHome, root }) => {
      skillSource(userHome, "alpha");
      const linkDir = skillsLinkDir(userHome);
      symlinkSync(join(userHome, ".agents", "skills", "ghost"), join(linkDir, "ghost"));

      const report = inspectStatus({ env, cwd: root });

      expect(report.skills.status).toBe("broken");
      expect(report.skills.links.broken).toEqual(["ghost"]);
      expect(report.warnings.some((warning) => warning.includes("斷鏈"))).toBe(true);
    });
  });

  test("技能只連結一部分時標示 partial 與缺少清單", async () => {
    await withStatusHome("status-skills-partial", async ({ env, userHome, root }) => {
      const alpha = skillSource(userHome, "alpha");
      skillSource(userHome, "beta");
      const linkDir = skillsLinkDir(userHome);
      symlinkSync(alpha, join(linkDir, "alpha"));

      const report = inspectStatus({ env, cwd: root });

      expect(report.skills.status).toBe("partial");
      expect(report.skills.links.missing).toEqual(["beta"]);
      expect(report.warnings.some((warning) => warning.includes("尚未連結") && warning.includes("beta"))).toBe(
        true,
      );
    });
  });

  test("對話索引不存在時回 not_indexed", async () => {
    await withStatusHome("status-transcripts-missing", async ({ env, root }) => {
      const report = inspectStatus({ env, cwd: root });

      expect(report.transcripts).toMatchObject({
        path: join(env.SMILEWORK_HOME as string, "transcripts.db"),
        exists: false,
        status: "not_indexed",
        sizeBytes: null,
        updatedAt: null,
      });
    });
  });

  test("對話索引存在時回 ready 與檔案大小", async () => {
    await withStatusHome("status-transcripts-ready", async ({ env, home, root }) => {
      writeFileSync(join(home, "transcripts.db"), "SQLite format 3\u0000", "utf8");

      const report = inspectStatus({ env, cwd: root });

      expect(report.transcripts).toMatchObject({
        exists: true,
        status: "ready",
        sizeBytes: 16,
      });
      expect(report.transcripts.updatedAt).not.toBeNull();
    });
  });

  test("工具回傳固定成功外框，資料庫缺失時仍 ok:true 並帶 warnings", async () => {
    await withStatusHome("status-envelope", async ({ env, home, root }) => {
      const snapshot = new Map(
        ["HOME", "SMILEWORK_HOME", "SMILEWORK_PROJECT", "SMILEWORK_ACTOR", "SMILEWORK_MODEL", "SMILEWORK_PROFILE"].map(
          (key) => [key, process.env[key]],
        ),
      );
      const previousCwd = process.cwd();
      try {
        process.env.HOME = env.HOME;
        process.env.SMILEWORK_HOME = env.SMILEWORK_HOME;
        delete process.env.SMILEWORK_PROJECT;
        delete process.env.SMILEWORK_ACTOR;
        delete process.env.SMILEWORK_MODEL;
        delete process.env.SMILEWORK_PROFILE;
        process.chdir(root);

        const call = await runTool(tool, {}, { env: { ...process.env }, cwd: root });
        const block = call.content[0];
        const text = block?.type === "text" ? block.text : "";
        const payload = JSON.parse(text) as {
          ok: boolean;
          summary: string;
          data: Record<string, unknown>;
        };

        expect(call.isError).toBe(false);
        expect(payload.ok).toBe(true);
        expect(payload.summary).toContain("smilework");
        expect(Array.isArray(payload.data.warnings)).toBe(true);
        expect((payload.data.warnings as string[]).length).toBeGreaterThan(0);
        expect(payload.data).toMatchObject({
          database: { status: "missing" },
          project: { status: "resolved" },
          actor: { name: "unknown" },
          profile: { name: "worker" },
        });
        expect(payload.data).toHaveProperty("version");
        expect(payload.data).toHaveProperty("skills");
        expect(payload.data).toHaveProperty("transcripts");
        expect(existsSync(join(home, "smilework.db"))).toBe(false);
      } finally {
        process.chdir(previousCwd);
        for (const [key, value] of snapshot) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
