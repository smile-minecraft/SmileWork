import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { openDatabase } from "../../../src/db/open.ts";
import { resolveProject } from "../../../src/project/resolve.ts";
import { registerProject } from "../../../src/project/registry.ts";
import { createGitRepo } from "../../helpers/git.ts";
import { withTempDir } from "../../helpers/temp.ts";
import { insertEvidence, insertWork } from "./helpers.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

interface RunningServer {
  client: Client;
  close(): Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli/index.ts", "mcp"],
    cwd: repoRoot,
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "smilework-lifecycle-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

function parsePayload(called: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = called.content[0];
  expect(block?.type).toBe("text");
  const text = block?.type === "text" ? block.text : "";
  return JSON.parse(text) as Record<string, unknown>;
}

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const called = await client.callTool({ name, arguments: args });
  expect(called.isError).toBe(false);
  const payload = parsePayload(called);
  expect(payload.ok).toBe(true);
  return payload.data as Record<string, unknown>;
}

describe("透過 MCP 跑一輪審查與結案", () => {
  test("approve 後可以結案，缺少伺服器證據時回固定失敗外框", async () => {
    await withTempDir("work-lifecycle-e2e", async (root) => {
      const home = join(root, "home", ".smilework");
      const repo = await createGitRepo(join(root, "repo"));
      const project = resolveProject({ explicitPath: repo, cwd: repo });

      const db = openDatabase({ home });
      registerProject(db, project);
      const passingWork = insertWork(db, project.projectId, {
        status: "review",
        risk: "high",
        acceptance: ["驗收項目"],
      });
      const serverEvidence = insertEvidence(db, project.projectId, passingWork, {
        serverIssued: true,
      });
      const blockedWork = insertWork(db, project.projectId, {
        status: "review",
        risk: "high",
        acceptance: ["驗收項目"],
      });
      const humanEvidence = insertEvidence(db, project.projectId, blockedWork, {
        serverIssued: false,
      });
      db.close();

      const server = await startServer({
        ...process.env,
        SMILEWORK_HOME: home,
        SMILEWORK_PROJECT: repo,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      });

      try {
        for (const workId of [passingWork, blockedWork]) {
          const reviewed = await server.client.callTool({
            name: "work_review",
            arguments: {
              id: workId,
              expectedVersion: 1,
              verdict: "approve",
              reviewer: "momus",
              note: "獨立看過",
            },
          });
          expect(reviewed.isError).toBe(false);
          expect(parsePayload(reviewed).ok).toBe(true);
        }

        const completed = await server.client.callTool({
          name: "work_complete",
          arguments: {
            id: passingWork,
            expectedVersion: 2,
            acceptance: [{ criterion: "驗收項目", met: true, evidenceIds: [serverEvidence] }],
            idempotencyKey: "e2e-complete-1",
          },
        });
        expect(completed.isError).toBe(false);
        expect(parsePayload(completed)).toMatchObject({ ok: true, data: { status: "done" } });

        const blocked = await server.client.callTool({
          name: "work_complete",
          arguments: {
            id: blockedWork,
            expectedVersion: 2,
            acceptance: [{ criterion: "驗收項目", met: true, evidenceIds: [humanEvidence] }],
          },
        });
        expect(blocked.isError).toBe(true);
        expect(parsePayload(blocked)).toMatchObject({
          ok: false,
          code: "SERVER_EVIDENCE_REQUIRED",
        });
      } finally {
        await server.close();
      }
    });
  }, 30_000);

  test("建立、開始、審查、結案沿用同一條版本線", async () => {
    await withTempDir("work-lifecycle-flow", async (root) => {
      const home = join(root, "home", ".smilework");
      const repo = await createGitRepo(join(root, "repo"));

      const server = await startServer({
        ...process.env,
        SMILEWORK_HOME: home,
        SMILEWORK_PROJECT: repo,
        SMILEWORK_ACTOR: "build",
        SMILEWORK_MODEL: "test-model",
      });

      try {
        const created = await callOk(server.client, "work_create", {
          title: "端到端流程",
          acceptance: ["驗收項目"],
          risk: "low",
        });
        const work = created.work as { id: string; version: number };
        expect(work.version).toBe(1);

        const updated = await callOk(server.client, "work_update", {
          id: work.id,
          expectedVersion: 1,
          status: "in_progress",
          evidence: [{ kind: "note", summary: "人工檢查完成" }],
        });
        expect(updated.work).toMatchObject({ status: "in_progress", version: 2 });
        const evidence = updated.evidence as Array<{ evidenceId: string }>;
        expect(evidence).toHaveLength(1);
        const evidenceId = evidence[0]?.evidenceId;
        if (!evidenceId) throw new Error("work_update 沒有回傳證據識別碼。");

        const reviewed = await callOk(server.client, "work_review", {
          id: work.id,
          expectedVersion: 2,
          verdict: "approve",
          reviewer: "momus",
        });
        expect(reviewed).toMatchObject({ status: "review", version: 3, reviewedVersion: 3 });

        const completed = await callOk(server.client, "work_complete", {
          id: work.id,
          expectedVersion: 3,
          acceptance: [{ criterion: "驗收項目", met: true, evidenceIds: [evidenceId] }],
        });
        expect(completed).toMatchObject({ status: "done", resolution: "completed", version: 4 });

        const fetched = await callOk(server.client, "work_get", { id: work.id });
        expect(fetched.work).toMatchObject({
          status: "done",
          resolution: "completed",
          version: 4,
          review: { verdict: "approve", reviewer: "momus", reviewedVersion: 3 },
        });
      } finally {
        await server.close();
      }
    });
  }, 30_000);
});
