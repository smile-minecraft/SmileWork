import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ProjectContext } from "../../../src/domain/project.ts";
import type { RiskLevel, WorkReview, WorkStatus } from "../../../src/domain/work.ts";
import type { ToolContext } from "../../../src/mcp/types.ts";
import type { ToolResult } from "../../../src/shared/result.ts";
import { tool as completeTool } from "../../../src/tools/work/complete.ts";
import { tool as reviewTool } from "../../../src/tools/work/review.ts";
import { insertTestProject, withTestDatabase } from "../../helpers/db.ts";

export interface LifecycleFixture {
  db: Database;
  projectId: string;
  context: ToolContext;
}

export interface WorkRow {
  work_id: string;
  status: string;
  resolution: string | null;
  owner: string;
  risk: string | null;
  acceptance: string;
  acceptance_results: string | null;
  review: string | null;
  reviewed_version: number | null;
  version: number;
}

export interface InsertWorkOptions {
  workId?: string;
  title?: string;
  status?: WorkStatus;
  resolution?: "completed" | "failed" | "abandoned" | null;
  owner?: string;
  risk?: RiskLevel | null;
  acceptance?: string[];
  version?: number;
  review?: WorkReview | null;
  reviewedVersion?: number | null;
}

/** 建立暫存資料庫與可注入的 tool context，所有識別碼都指向同一個測試專案。 */
export async function withLifecycle<T>(
  run: (fixture: LifecycleFixture) => T | Promise<T>,
): Promise<T> {
  return withTestDatabase(async ({ db }) => {
    const projectId = insertTestProject(db);
    const project: ProjectContext = {
      projectId,
      worktreePath: `/tmp/${projectId}`,
      commonDir: `/tmp/${projectId}/.git`,
      rootPath: `/tmp/${projectId}`,
    };
    const context: ToolContext = {
      actor: { name: "build", model: "test-model", declared: true },
      actorHint: null,
      db: () => db,
      resolveProject: () => project,
      tryResolveProject: () => project,
      close: () => {},
    };
    return run({ db, projectId, context });
  });
}

export function insertWork(db: Database, projectId: string, options: InsertWorkOptions = {}): string {
  const workId = options.workId ?? `work-${randomUUID()}`;
  const now = new Date().toISOString();
  const review = options.review
    ? {
        verdict: options.review.verdict,
        reviewer: options.review.reviewer,
        ...(options.review.note ? { note: options.review.note } : {}),
        ...(options.review.reviewedAt ? { reviewedAt: options.review.reviewedAt } : {}),
      }
    : null;
  const reviewedVersion =
    options.reviewedVersion ?? options.review?.reviewedVersion ?? null;

  db.query(
    `INSERT INTO work_items (
       work_id, project_id, kind, title, status, resolution, owner, priority,
       acceptance, risk, review, reviewed_version, version,
       created_at, updated_at, created_by, updated_by
     ) VALUES (?, ?, 'task', ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, 'build', 'build')`,
  ).run(
    workId,
    projectId,
    options.title ?? "測試工作",
    options.status ?? "review",
    options.resolution ?? null,
    options.owner ?? "build",
    JSON.stringify(options.acceptance ?? []),
    options.risk ?? null,
    review ? JSON.stringify(review) : null,
    reviewedVersion,
    options.version ?? 1,
    now,
    now,
  );

  return workId;
}

export function insertEvidence(
  db: Database,
  projectId: string,
  workId: string,
  options: { evidenceId?: string; serverIssued?: boolean; summary?: string } = {},
): string {
  const evidenceId = options.evidenceId ?? `evidence-${randomUUID()}`;
  db.query(
    `INSERT INTO evidence (
       evidence_id, project_id, work_id, kind, actor, summary, command, server_issued, created_at
     ) VALUES (?, ?, ?, 'test', 'build', ?, 'bun test', ?, ?)`,
  ).run(
    evidenceId,
    projectId,
    workId,
    options.summary ?? "測試證據",
    options.serverIssued ? 1 : 0,
    new Date().toISOString(),
  );
  return evidenceId;
}

export function insertDependency(db: Database, workId: string, dependsOnWorkId: string): void {
  db.query(
    "INSERT INTO work_dependencies (work_id, depends_on_work_id, created_at) VALUES (?, ?, ?)",
  ).run(workId, dependsOnWorkId, new Date().toISOString());
}

export function readWork(db: Database, workId: string): WorkRow | null {
  return (
    db
      .query<WorkRow, [string]>(
        `SELECT work_id, status, resolution, owner, risk, acceptance, acceptance_results,
                review, reviewed_version, version
         FROM work_items WHERE work_id = ?`,
      )
      .get(workId) ?? null
  );
}

export function countEvents(db: Database, projectId: string, workId: string): number {
  const row = db
    .query<{ count: number }, [string, string]>(
      "SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND work_id = ?",
    )
    .get(projectId, workId);
  return row?.count ?? 0;
}

export async function callComplete(
  context: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = completeTool.inputSchema.parse(input);
  return completeTool.handler(parsed, context);
}

export async function callReview(
  context: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = reviewTool.inputSchema.parse(input);
  return reviewTool.handler(parsed, context);
}
