import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db/index.ts";
import { createGitRepo, createGitWorktree, moveDirectory } from "../helpers/git.ts";
import { withTempDir } from "../helpers/temp.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const cliEntry = "src/cli/index.ts";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: readonly string[], env: Record<string, string>, cwd = repoRoot): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

interface ProjectListPayload {
  projects: Array<{
    projectId: string;
    commonDir: string;
    rootPath: string;
    worktrees: string[];
  }>;
}

describe("project CLI", () => {
  test("project list 可以登記並列出專案與 worktree", async () => {
    await withTempDir("project-list", async (root) => {
      const home = join(root, "home", ".smilework");
      const repo = await createGitRepo(join(root, "repo"));
      const worktree = await createGitWorktree(repo, join(root, "worktree"), "feature");
      const env = { ...process.env, SMILEWORK_HOME: home };

      const main = await runCli(["project", "list", "--project", repo, "--json"], env);
      expect(main.exitCode).toBe(0);
      const mainPayload = parseJson<ProjectListPayload>(main.stdout);
      expect(mainPayload.projects).toHaveLength(1);
      const projectId = mainPayload.projects[0]?.projectId;
      expect(projectId).toBeDefined();

      const linked = await runCli(["project", "list", "--project", worktree, "--json"], env);
      expect(linked.exitCode).toBe(0);
      const linkedPayload = parseJson<ProjectListPayload>(linked.stdout);
      expect(linkedPayload.projects).toHaveLength(1);
      expect(linkedPayload.projects[0]?.projectId).toBe(projectId);
      expect(linkedPayload.projects[0]?.worktrees).toHaveLength(2);
      expect(linkedPayload.projects[0]?.worktrees).toContain(realpathSync(repo));
      expect(linkedPayload.projects[0]?.worktrees).toContain(realpathSync(worktree));

      const plain = await runCli(["project", "list"], env);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toContain(projectId ?? "");

      const db = openDatabase({ home });
      try {
        const row = db
          .query<{ root_path: string }, []>("SELECT root_path FROM projects")
          .get();
        expect(row?.root_path).toBe(realpathSync(repo));
      } finally {
        db.close();
      }
    });
  }, 30_000);

  test("搬移 main 後 relink --id 保留 linked worktree 並更新 root_path", async () => {
    await withTempDir("project-relink-linked", async (root) => {
      const home = join(root, "home", ".smilework");
      const env = { ...process.env, SMILEWORK_HOME: home };
      const originalMain = join(root, "main");
      await createGitRepo(originalMain);
      const linkedPath = await createGitWorktree(originalMain, join(root, "linked"), "feature");

      const mainList = await runCli(["project", "list", "--project", originalMain, "--json"], env);
      expect(mainList.exitCode).toBe(0);
      const oldProjectId = parseJson<ProjectListPayload>(mainList.stdout).projects[0]?.projectId;
      expect(oldProjectId).toBeDefined();

      const linkedList = await runCli(["project", "list", "--project", linkedPath, "--json"], env);
      expect(linkedList.exitCode).toBe(0);
      expect(parseJson<ProjectListPayload>(linkedList.stdout).projects[0]?.worktrees).toHaveLength(2);

      const movedMain = join(root, "main-moved");
      await moveDirectory(originalMain, movedMain);

      const relinked = await runCli(
        ["project", "relink", movedMain, "--id", oldProjectId ?? "", "--json"],
        env,
      );
      expect(relinked.exitCode).toBe(0);
      const payload = parseJson<{ projectId: string }>(relinked.stdout);

      const db = openDatabase({ home });
      try {
        const project = db
          .query<{ root_path: string }, [string]>("SELECT root_path FROM projects WHERE project_id = ?")
          .get(payload.projectId);
        expect(project?.root_path).toBe(realpathSync(movedMain));
        const worktrees = db
          .query<{ worktree_path: string }, [string]>(
            "SELECT worktree_path FROM project_worktrees WHERE project_id = ? ORDER BY worktree_path",
          )
          .all(payload.projectId);
        expect(worktrees).toHaveLength(2);
        expect(worktrees.map((row) => row.worktree_path)).toContain(realpathSync(movedMain));
        expect(worktrees.map((row) => row.worktree_path)).toContain(realpathSync(linkedPath));
      } finally {
        db.close();
      }
    });
  }, 30_000);

  test("relink --from 可以用 /var symlink 舊路徑找到專案", async () => {
    await withTempDir("project-relink-from", async (root) => {
      const home = join(root, "home", ".smilework");
      const env = { ...process.env, SMILEWORK_HOME: home };
      const originalPath = join(root, "repo-from");
      await createGitRepo(originalPath);

      const listed = await runCli(["project", "list", "--project", originalPath, "--json"], env);
      expect(listed.exitCode).toBe(0);
      const oldProjectId = parseJson<ProjectListPayload>(listed.stdout).projects[0]?.projectId;
      expect(oldProjectId).toBeDefined();

      const movedPath = join(root, "repo-from-moved");
      await moveDirectory(originalPath, movedPath);

      const fromPath = root === realpathSync(root) ? originalPath : join(root, "repo-from");
      const relinked = await runCli(["project", "relink", movedPath, "--from", fromPath, "--json"], env);
      expect(relinked.exitCode).toBe(0);
      const payload = parseJson<{ previousProjectId: string; projectId: string }>(relinked.stdout);
      expect(payload.previousProjectId).toBe(oldProjectId ?? "");
      expect(payload.projectId).not.toBe(oldProjectId);
    });
  }, 30_000);

  test("project relink 更新專案身分並 cascade 既有資料", async () => {
    await withTempDir("project-relink", async (root) => {
      const home = join(root, "home", ".smilework");
      const env = { ...process.env, SMILEWORK_HOME: home };
      const originalPath = join(root, "repo-a");
      await createGitRepo(originalPath);

      const listed = await runCli(["project", "list", "--project", originalPath, "--json"], env);
      expect(listed.exitCode).toBe(0);
      const oldProjectId = parseJson<ProjectListPayload>(listed.stdout).projects[0]?.projectId;
      expect(oldProjectId).toBeDefined();

      const db = openDatabase({ home });
      try {
        const now = new Date().toISOString();
        db.query(
          `INSERT INTO work_items (work_id, project_id, kind, title, status, owner, priority, created_at, updated_at, created_by, updated_by)
           VALUES ('work-relink-1', ?, 'task', '搬移前的工作', 'open', 'build', 'normal', ?, ?, 'build', 'build')`,
        ).run(oldProjectId ?? "", now, now);
        db.query(
          `INSERT INTO idempotency_keys (project_id, tool, key, request_hash, response, created_at)
           VALUES (?, 'work_create', 'idem-1', 'hash', '{}', ?)`,
        ).run(oldProjectId ?? "", now);
        db.query(
          `INSERT INTO usage_events (usage_id, project_id, action, actor, created_at)
           VALUES ('usage-1', ?, 'knowledge_read', 'build', ?)`,
        ).run(oldProjectId ?? "", now);
        db.query(
          `INSERT INTO id_mappings (entity, layer, source_id, source_root, target_id, imported_at)
           VALUES ('work', 'project', ?, ?, 'work-relink-1', ?)`,
        ).run(`${oldProjectId ?? ""}\u0000legacy-source`, oldProjectId ?? "", now);
      } finally {
        db.close();
      }

      const movedPath = join(root, "repo-b");
      await moveDirectory(originalPath, movedPath);

      const relinked = await runCli(
        ["project", "relink", movedPath, "--id", oldProjectId ?? "", "--json"],
        env,
      );
      expect(relinked.exitCode).toBe(0);
      const payload = parseJson<{
        previousProjectId: string;
        projectId: string;
        commonDir: string;
        worktreePath: string;
      }>(relinked.stdout);
      expect(payload.previousProjectId).toBe(oldProjectId ?? "");
      expect(payload.projectId).not.toBe(oldProjectId);
      expect(payload.worktreePath).toBe(realpathSync(movedPath));
      expect(payload.commonDir).toBe(realpathSync(join(movedPath, ".git")));

      const checkDb = openDatabase({ home });
      try {
        const work = checkDb
          .query<{ project_id: string }, []>("SELECT project_id FROM work_items WHERE work_id = 'work-relink-1'")
          .get();
        expect(work?.project_id).toBe(payload.projectId);
        const idempotency = checkDb
          .query<{ project_id: string }, []>("SELECT project_id FROM idempotency_keys WHERE key = 'idem-1'")
          .get();
        expect(idempotency?.project_id).toBe(payload.projectId);
        const usage = checkDb
          .query<{ project_id: string }, []>("SELECT project_id FROM usage_events WHERE usage_id = 'usage-1'")
          .get();
        expect(usage?.project_id).toBe(payload.projectId);
        const mapping = checkDb
          .query<{ source_root: string; source_id: string }, []>(
            "SELECT source_root, source_id FROM id_mappings WHERE target_id = 'work-relink-1'",
          )
          .get();
        expect(mapping?.source_root).toBe(payload.projectId);
        expect(mapping?.source_id).toBe(`${payload.projectId}\u0000legacy-source`);
        const projects = checkDb
          .query<{ project_id: string; common_dir: string }, []>("SELECT project_id, common_dir FROM projects")
          .all();
        expect(projects).toEqual([
          { project_id: payload.projectId, common_dir: realpathSync(join(movedPath, ".git")) },
        ]);
      } finally {
        checkDb.close();
      }
    });
  }, 30_000);

  test("relink 缺少 --id 與 --from 時回錯誤", async () => {
    await withTempDir("project-relink-missing", async (root) => {
      const home = join(root, "home", ".smilework");
      const repo = await createGitRepo(join(root, "repo"));
      const result = await runCli(["project", "relink", repo], { ...process.env, SMILEWORK_HOME: home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--id");
      expect(result.stderr).toContain("--from");
    });
  }, 30_000);
});
