import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createSharedDatabase } from "../../src/mcp/context.ts";
import { runTool } from "../../src/mcp/result.ts";
import type { ToolDefinition } from "../../src/mcp/types.ts";
import { ERROR_CODES, SmileworkError } from "../../src/shared/errors.ts";
import { ok } from "../../src/shared/result.ts";
import { clearGitLocationCache, gitLocationFor } from "../../src/project/git.ts";
import { REGISTER_TOUCH_INTERVAL_MS, registerProject } from "../../src/project/registry.ts";
import { resolveProject } from "../../src/project/resolve.ts";
import { withTestDatabase } from "../helpers/db.ts";
import { createGitRepo, createGitWorktree } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");

function trackImmediateTransactions(db: Database): { count(): number; restore(): void } {
  let count = 0;
  const original = db.exec.bind(db);
  const target = db as unknown as { exec: (sql: string) => void };
  target.exec = (sql: string): void => {
    if (sql === "BEGIN IMMEDIATE") count += 1;
    original(sql);
  };
  return {
    count: () => count,
    restore: () => {
      target.exec = original;
    },
  };
}

function expectConflictCode(error: unknown): void {
  expect(error).toBeInstanceOf(SmileworkError);
  expect((error as SmileworkError).code).toBe(ERROR_CODES.projectIdConflict);
}

afterEach(() => {
  setSystemTime();
  clearGitLocationCache();
});

describe("MCP 執行期資源 reuse", () => {
  test("共用資料庫在第一次用到才開啟，close 後釋放", async () => {
    await withTempDir("shared-db-lazy", async (root) => {
      const home = join(root, "home", ".smilework");
      const env = { ...process.env, SMILEWORK_HOME: home };
      const shared = createSharedDatabase({ env });
      const dbPath = join(home, "smilework.db");

      expect(existsSync(dbPath)).toBe(false);
      const db = shared.get();
      expect(existsSync(dbPath)).toBe(true);
      expect(shared.get()).toBe(db);

      shared.close();
      expect(() => db.query("SELECT 1 AS value").get()).toThrow();
      shared.close();
    });
  });

  test("不同 home 的共用連線各自獨立", async () => {
    await withTempDir("shared-db-isolation", async (root) => {
      const first = createSharedDatabase({
        env: { ...process.env, SMILEWORK_HOME: join(root, "a") },
      });
      const second = createSharedDatabase({
        env: { ...process.env, SMILEWORK_HOME: join(root, "b") },
      });
      try {
        expect(first.get().filename).not.toBe(second.get().filename);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  test("runTool 重複使用傳入的共用連線，且不會關閉它", async () => {
    const probe: ToolDefinition = {
      name: "db_probe",
      title: "資料庫探針",
      description: "測試用",
      domain: "work",
      inputSchema: z.object({}),
      handler: (_input, context) => {
        context.db().query("SELECT 1 AS value").get();
        return ok("完成", {});
      },
    };

    await withTempDir("shared-db-tool", async (root) => {
      const env = { ...process.env, SMILEWORK_HOME: join(root, "home", ".smilework") };
      const shared = createSharedDatabase({ env });
      let gets = 0;
      const counting = {
        get() {
          gets += 1;
          return shared.get();
        },
        close(): void {
          shared.close();
        },
      };

      try {
        for (let call = 0; call < 2; call += 1) {
          const result = await runTool(probe, {}, { env, cwd: repoRoot, sharedDb: counting });
          expect(result.isError).toBe(false);
        }
        expect(gets).toBe(2);
        expect(() => shared.get().query("SELECT 1 AS value").get()).not.toThrow();
      } finally {
        shared.close();
      }
    });
  });

  test("runTool 未提供共用連線時維持原有行為", async () => {
    const probe: ToolDefinition = {
      name: "standalone_db_probe",
      title: "資料庫探針",
      description: "測試用",
      domain: "work",
      inputSchema: z.object({}),
      handler: (_input, context) => {
        context.db().query("SELECT 1 AS value").get();
        return ok("完成", {});
      },
    };

    await withTempDir("standalone-db-tool", async (root) => {
      const env = { ...process.env, SMILEWORK_HOME: join(root, "home", ".smilework") };
      const result = await runTool(probe, {}, { env, cwd: repoRoot });
      expect(result.isError).toBe(false);
      expect(existsSync(join(root, "home", ".smilework", "smilework.db"))).toBe(true);
    });
  });
});

describe("registerProject 避免無謂寫入鎖", () => {
  test("近期且無衝突的登記直接回傳，不開 BEGIN IMMEDIATE", async () => {
    await withTestDatabase(async ({ db }) => {
      await withTempDir("register-recent", async (root) => {
        const repo = await createGitRepo(join(root, "repo"));
        const context = resolveProject({ explicitPath: repo });
        const tracker = trackImmediateTransactions(db);
        try {
          const first = registerProject(db, context);
          expect(tracker.count()).toBe(1);

          const second = registerProject(db, context);
          expect(tracker.count()).toBe(1);
          expect(second.lastSeenAt).toBe(first.lastSeenAt);
          expect(second.projectId).toBe(first.projectId);
        } finally {
          tracker.restore();
        }
      });
    });
  });

  test("last_seen_at 過期時照樣刷新", async () => {
    await withTestDatabase(async ({ db }) => {
      await withTempDir("register-stale", async (root) => {
        const repo = await createGitRepo(join(root, "repo"));
        const context = resolveProject({ explicitPath: repo });
        registerProject(db, context);
        const stale = new Date(Date.now() - REGISTER_TOUCH_INTERVAL_MS - 5_000).toISOString();
        db.query("UPDATE projects SET last_seen_at = ? WHERE project_id = ?").run(
          stale,
          context.projectId,
        );

        const tracker = trackImmediateTransactions(db);
        try {
          const refreshed = registerProject(db, context);
          expect(tracker.count()).toBe(1);
          expect(Date.parse(refreshed.lastSeenAt)).toBeGreaterThan(Date.parse(stale));
        } finally {
          tracker.restore();
        }
      });
    });
  });

  test("近期資料的衝突檢查仍然生效", async () => {
    await withTestDatabase(async ({ db }) => {
      await withTempDir("register-conflict", async (root) => {
        const repo = await createGitRepo(join(root, "repo"));
        const context = resolveProject({ explicitPath: repo });
        registerProject(db, context);

        expect(() =>
          registerProject(db, {
            ...context,
            commonDir: "path:/different/project",
          }),
        ).toThrow(SmileworkError);
        try {
          registerProject(db, { ...context, commonDir: "path:/different/project" });
        } catch (error) {
          expectConflictCode(error);
        }

        try {
          registerProject(db, { ...context, projectId: "another-project" });
          throw new Error("應該偵測 worktree 衝突");
        } catch (error) {
          expectConflictCode(error);
        }
      });
    });
  });

  test("import: 佔位資料仍會升級，不能被快取路徑跳過", async () => {
    await withTestDatabase(async ({ db }) => {
      await withTempDir("register-import", async (root) => {
        const repo = await createGitRepo(join(root, "repo"));
        const context = resolveProject({ explicitPath: repo });
        const importedId = "imported-project";
        const placeholder = `import:${importedId}`;
        const now = new Date().toISOString();
        db.query(
          `INSERT INTO projects (project_id, common_dir, root_path, created_at, updated_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(importedId, placeholder, placeholder, now, now, now);
        db.query(
          `INSERT INTO project_worktrees (project_id, worktree_path, git_dir, created_at, last_seen_at)
           VALUES (?, ?, NULL, ?, ?)`,
        ).run(importedId, context.worktreePath, now, now);

        const tracker = trackImmediateTransactions(db);
        try {
          const upgraded = registerProject(db, { ...context, projectId: importedId });
          expect(tracker.count()).toBe(1);
          expect(upgraded.commonDir).toBe(context.commonDir);
          expect(upgraded.rootPath).toBe(context.rootPath);
        } finally {
          tracker.restore();
        }
      });
    });
  });
});

describe("gitLocationFor 短 TTL 快取", () => {
  test("成功結果快取 5 秒，失敗不快取，clear 後立即重查", async () => {
    await withTempDir("git-location-cache", async (root) => {
      const target = join(root, "target");
      const mainRepo = join(root, "main");
      clearGitLocationCache();

      await createGitRepo(target);
      const asMain = gitLocationFor(target);
      expect(asMain).not.toBeNull();

      // 同一路徑改成 linked worktree，重新查詢的結果會不同。
      await rm(target, { recursive: true, force: true });
      await createGitRepo(mainRepo);
      await createGitWorktree(mainRepo, target, "linked");
      expect(gitLocationFor(target)?.commonDir).toBe(asMain?.commonDir);

      setSystemTime(new Date(Date.now() + 6_000));
      const asLinked = gitLocationFor(target);
      expect(asLinked?.commonDir).not.toBe(asMain?.commonDir);

      await rm(target, { recursive: true, force: true });
      await createGitRepo(target);
      expect(gitLocationFor(target)?.commonDir).toBe(asLinked?.commonDir);
      clearGitLocationCache();
      expect(gitLocationFor(target)?.commonDir).toBe(asMain?.commonDir);

      const nonRepo = join(root, "non-repo");
      await mkdir(nonRepo, { recursive: true });
      expect(gitLocationFor(nonRepo)).toBeNull();
      await createGitRepo(nonRepo);
      expect(gitLocationFor(nonRepo)?.rootPath).toBe(realpathSync(nonRepo));
    });
  }, 30_000);
});
