import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectIdFromCommonDir } from "../../src/shared/hash.ts";
import { gitLocationFor } from "../../src/project/git.ts";
import { parseJson, runCli, withCliEnvironment } from "./helpers.ts";
import { createGitRepo } from "../helpers/git.ts";

interface UsagePayload {
  usage: {
    usageId: string;
    projectId: string | null;
    layer: string | null;
    knowledgeId: string | null;
    version: number | null;
    action: string;
    actor: string;
    actorModel: string | null;
    query: string | null;
    details: Record<string, unknown> | null;
    createdAt: string;
  };
}

interface UsageRow {
  usage_id: string;
  project_id: string | null;
  layer: string | null;
  knowledge_id: string | null;
  version: number | null;
  action: string;
  actor: string;
  actor_model: string | null;
  query: string | null;
  details: string | null;
  created_at: string;
}

function readUsageRows(dbPath: string): UsageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<UsageRow, []>(
        "SELECT usage_id, project_id, layer, knowledge_id, version, action, actor, actor_model, query, details, created_at FROM usage_events ORDER BY created_at, usage_id",
      )
      .all();
  } finally {
    db.close();
  }
}

describe("usage 子命令", () => {
  test("record 寫入完整的使用事件", async () => {
    await withCliEnvironment("cli-usage-record", async (context) => {
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(
        [
          "usage",
          "record",
          "--action",
          "skill_read",
          "--knowledge",
          "topic-alpha",
          "--layer",
          "global",
          "--version",
          "3",
          "--query",
          "怎麼設定 hook",
          "--details",
          '{"host":"opencode"}',
          "--json",
        ],
        env,
        context.root,
      );

      expect(result.exitCode).toBe(0);
      const payload = parseJson<UsagePayload>(result.stdout);
      expect(payload.usage).toMatchObject({
        projectId: null,
        layer: "global",
        knowledgeId: "topic-alpha",
        version: 3,
        action: "skill_read",
        actor: "build",
        actorModel: "test-model",
        query: "怎麼設定 hook",
        details: { host: "opencode" },
      });
      expect(payload.usage.usageId).toStartWith("usage-");
      expect(payload.usage.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const rows = readUsageRows(join(context.home, "smilework.db"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        usage_id: payload.usage.usageId,
        project_id: null,
        layer: "global",
        knowledge_id: "topic-alpha",
        version: 3,
        action: "skill_read",
        actor: "build",
        actor_model: "test-model",
        query: "怎麼設定 hook",
        details: '{"host":"opencode"}',
      });
    });
  }, 30_000);

  test("--project 解析後寫入 project_id", async () => {
    await withCliEnvironment("cli-usage-project", async (context) => {
      const repo = await createGitRepo(join(context.root, "repo"));
      const location = gitLocationFor(repo);
      if (!location) throw new Error("測試 repo 無法解析");
      const expectedProjectId = projectIdFromCommonDir(location.commonDir);
      const env = {
        ...context.env,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      };

      const result = await runCli(
        ["usage", "record", "--action", "skill_read", "--project", repo, "--json"],
        env,
        context.root,
      );

      expect(result.exitCode).toBe(0);
      const payload = parseJson<UsagePayload>(result.stdout);
      expect(payload.usage.projectId).toBe(expectedProjectId);
      const rows = readUsageRows(join(context.home, "smilework.db"));
      expect(rows[0]?.project_id).toBe(expectedProjectId);
    });
  }, 30_000);

  test("--details 不是合法 JSON 時回錯誤且不寫入", async () => {
    await withCliEnvironment("cli-usage-bad-details", async (context) => {
      const result = await runCli(
        ["usage", "record", "--action", "skill_read", "--details", "not-json"],
        context.env,
        context.root,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--details");
      expect(existsSync(join(context.home, "smilework.db"))).toBe(false);
    });
  }, 30_000);

  test("缺少 --action、非法 layer 或 version 時回錯誤", async () => {
    await withCliEnvironment("cli-usage-invalid", async (context) => {
      const missing = await runCli(["usage", "record"], context.env, context.root);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("--action");

      const layer = await runCli(
        ["usage", "record", "--action", "skill_read", "--layer", "nope"],
        context.env,
        context.root,
      );
      expect(layer.exitCode).toBe(1);

      const version = await runCli(
        ["usage", "record", "--action", "skill_read", "--version", "abc"],
        context.env,
        context.root,
      );
      expect(version.exitCode).toBe(1);
    });
  }, 30_000);
});
