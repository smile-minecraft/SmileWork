import type { Command } from "../command.ts";
import { openDatabase } from "../../db/index.ts";
import { listProjects, registerProject, relinkProject } from "../../project/index.ts";
import type { ProjectRecord } from "../../domain/project.ts";
import { resolveProject } from "../../project/resolve.ts";
import { failureFromError } from "../../shared/result.ts";

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const separator = body.indexOf("=");
    if (separator >= 0) {
      values.set(body.slice(0, separator), body.slice(separator + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      index += 1;
    } else {
      flags.add(body);
    }
  }

  return { positionals, values, flags };
}

function printFailure(error: unknown): void {
  const failure = failureFromError(error);
  console.error(`錯誤：${failure.message}`);
  console.error(`下一步：${failure.nextAction}`);
}

function projectSummary(project: ProjectRecord): Record<string, unknown> {
  return {
    projectId: project.projectId,
    commonDir: project.commonDir,
    rootPath: project.rootPath,
    worktrees: project.worktrees.map((worktree) => worktree.worktreePath),
  };
}

function runList(args: ParsedArgs): number {
  const json = args.flags.has("json");
  const db = openDatabase();
  try {
    const projectPath = args.values.get("project");
    if (projectPath) {
      registerProject(db, resolveProject({ explicitPath: projectPath }));
    }

    const projects = listProjects(db);
    if (json) {
      process.stdout.write(`${JSON.stringify({ projects: projects.map(projectSummary) })}\n`);
      return 0;
    }

    if (projects.length === 0) {
      console.log("尚未登記任何專案。");
      return 0;
    }

    for (const project of projects) {
      const worktrees = project.worktrees.map((worktree) => worktree.worktreePath).join(", ");
      console.log(`${project.projectId}  ${project.rootPath}${worktrees ? `  ${worktrees}` : ""}`);
    }
    return 0;
  } catch (error) {
    printFailure(error);
    return 1;
  } finally {
    db.close();
  }
}

function runRelink(args: ParsedArgs): number {
  const json = args.flags.has("json");
  const newPath = args.positionals[0] ?? args.values.get("project") ?? process.cwd();
  const projectId = args.values.get("id");
  const fromPath = args.values.get("from");

  if (!projectId && !fromPath) {
    console.error("project relink 需要 --id <舊 projectId> 或 --from <舊路徑>，用來指出要重新對應的專案。");
    return 1;
  }

  const db = openDatabase();
  try {
    const result = relinkProject(db, {
      newPath,
      ...(projectId ? { projectId } : {}),
      ...(fromPath ? { fromPath } : {}),
    });

    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log(`專案已重新對應：${result.previousProjectId} -> ${result.projectId}`);
      console.log(`路徑：${result.worktreePath}`);
    }
    return 0;
  } catch (error) {
    printFailure(error);
    return 1;
  } finally {
    db.close();
  }
}

export const command: Command = {
  description: "管理專案識別",
  run(args: readonly string[]): number {
    const [first] = args;
    if (args.length === 0 || first === "--help" || first === "-h") {
      console.log("用法：smilework project <list|relink> [參數]");
      console.log("  list [--project <路徑>] [--json]");
      console.log("  relink <新路徑> --id <舊 projectId> | --from <舊路徑> [--json]");
      return 0;
    }

    const parsed = parseArgs(args);
    const [subcommand] = parsed.positionals;

    if (subcommand === "list") {
      parsed.positionals.shift();
      return runList(parsed);
    }
    if (subcommand === "relink") {
      parsed.positionals.shift();
      return runRelink(parsed);
    }

    console.error("用法：smilework project <list|relink> [參數]");
    return 1;
  },
};
