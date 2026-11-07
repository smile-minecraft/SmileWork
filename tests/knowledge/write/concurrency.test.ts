import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerProject } from "../../../src/project/registry.ts";
import type { ToolResult, ToolSuccess } from "../../../src/shared/result.ts";
import { withDatabase, withKnowledgeWriteFixture } from "./helpers.ts";

interface ChildOutcome {
  result: ToolResult;
  stderr: string;
}

async function runChild(
  script: string,
  env: NodeJS.ProcessEnv,
  layer: "project" | "global",
): Promise<ChildOutcome> {
  const child = Bun.spawn(["bun", script], {
    env: { ...env, WRITE_LAYER: layer },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`子程序失敗（${exitCode}）：${stderr || stdout}`);
  }
  return { result: JSON.parse(stdout) as ToolResult, stderr };
}

describe("knowledge_write 並行檢查", () => {
  test("同時寫入全域與專案同名技能時，只有一個成功", async () => {
    await withKnowledgeWriteFixture(async (fixture) => {
      // 先完成 migration 與專案登記，讓兩個子程序只競爭知識寫入交易。
      withDatabase(fixture, (db) => registerProject(db, fixture.project));

      const goFile = join(fixture.root, "start-race");
      const script = join(import.meta.dir, "concurrent-write-child.ts");
      const env: NodeJS.ProcessEnv = { ...fixture.env, GO_FILE: goFile };

      const projectChild = runChild(script, env, "project");
      const globalChild = runChild(script, env, "global");
      writeFileSync(goFile, "", "utf8");

      const [projectOutcome, globalOutcome] = await Promise.all([
        projectChild,
        globalChild,
      ]);
      const outcomes = [projectOutcome.result, globalOutcome.result];
      const successes = outcomes.filter((result) => result.ok);
      const failures = outcomes.filter((result) => !result.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: "KNOWLEDGE_LAYER_CONFLICT" });

      const success = successes[0] as ToolSuccess<{ entry: { layer: string } }>;
      expect(["project", "global"]).toContain(success.data.entry.layer);

      const count = withDatabase(
        fixture,
        (db) =>
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM knowledge_entries WHERE knowledge_id = ?",
            )
            .get("race-skill")?.count ?? 0,
      );
      expect(count).toBe(1);
    });
  });
});
