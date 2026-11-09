import { accessSync, constants, statSync } from "node:fs";
import type { Command } from "../command.ts";
import {
  loadSmileworkConfig,
  PROFILE_NAMES,
  type SmileworkConfig,
} from "../../mcp/profiles.ts";
import { inspectStatus, type StatusReport } from "../../status/index.ts";
import type {
  ActorStatus,
  DatabaseHealth,
  ProjectHealth,
  SkillHealth,
  TranscriptHealth,
} from "../../status/index.ts";
import { smileworkHome } from "../../shared/paths.ts";

const USAGE = [
  "用法：smilework doctor [--json]",
  "",
  "檢查設定、資料庫、專案解析、actor、技能連結與對話索引。",
  "有警告時以 1 結束；--json 輸出完整檢查結果。",
  "",
].join("\n");

export type DoctorCheckStatus = "ok" | "warn";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  nextAction: string | null;
}

export interface DoctorResult {
  ok: boolean;
  exitCode: number;
  checks: DoctorCheck[];
  report: StatusReport;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function okCheck(name: string, detail: string): DoctorCheck {
  return { name, status: "ok", detail, nextAction: null };
}

function warnCheck(name: string, detail: string, nextAction: string): DoctorCheck {
  return { name, status: "warn", detail, nextAction };
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function configCheck(env: NodeJS.ProcessEnv, config: SmileworkConfig): DoctorCheck {
  const home = smileworkHome(env);

  let info;
  try {
    info = statSync(home);
  } catch (error) {
    if (isMissingPathError(error)) {
      return okCheck("設定", `家目錄尚未建立：${home}（第一次寫入時會自動建立）`);
    }
    return warnCheck("設定", `家目錄無法檢查：${home}`, "確認 SMILEWORK_HOME 的路徑與權限。");
  }

  if (!info.isDirectory()) {
    return warnCheck(
      "設定",
      `SMILEWORK_HOME 不是資料夾：${home}`,
      "把 SMILEWORK_HOME 指向資料夾，或移除佔用該路徑的檔案。",
    );
  }

  try {
    accessSync(home, constants.W_OK);
  } catch {
    return warnCheck(
      "設定",
      `家目錄不可寫：${home}`,
      "確認目前使用者對 SMILEWORK_HOME 有寫入權限，或改設到可寫入的位置。",
    );
  }

  if (config.warnings.length > 0) {
    return warnCheck(
      "設定",
      `家目錄可寫：${home}；profile：${config.profile}。設定警告：${config.warnings.join("；")}`,
      `檢查 SMILEWORK_PROFILE 與設定檔（config.jsonc、.smilework.jsonc）的內容；profile 只接受 ${PROFILE_NAMES.join("、")}。`,
    );
  }

  return okCheck("設定", `家目錄可寫：${home}；profile：${config.profile}`);
}

function databaseCheck(database: DatabaseHealth): DoctorCheck {
  if (database.status === "ok") {
    const size = database.sizeBytes ?? 0;
    return okCheck(
      "資料庫",
      `正常（schema v${database.schemaVersion ?? 1}，${size} bytes）：${database.path}`,
    );
  }

  if (database.status === "missing") {
    return warnCheck(
      "資料庫",
      `尚未建立：${database.path}`,
      "執行任一個寫入指令（例如 smilework project list --project .）會建立資料庫並套用 migration。",
    );
  }

  if (database.status === "uninitialized") {
    return warnCheck(
      "資料庫",
      `尚未初始化：${database.path}`,
      "執行任一個寫入指令會套用 migration；完成後重新執行 smilework doctor。",
    );
  }

  return warnCheck(
    "資料庫",
    `無法讀取：${database.error ?? "未知錯誤"}（${database.path}）`,
    "確認路徑是 SQLite 檔案且目前使用者可讀寫；必要時移開損壞的檔案後重建。",
  );
}

function projectCheck(project: ProjectHealth): DoctorCheck {
  if (project.status === "resolved") {
    return okCheck("專案", `${project.projectId}（${project.worktreePath}）`);
  }
  return warnCheck(
    "專案",
    `無法解析：${project.reason ?? "未知原因"}`,
    project.nextAction ?? "在 git repo 內執行，或設定 SMILEWORK_PROJECT 指向 repo。",
  );
}

function actorCheck(actor: ActorStatus): DoctorCheck {
  if (!actor.declared) {
    return warnCheck(
      "actor",
      "未設定 SMILEWORK_ACTOR，操作會記為 unknown",
      "在宿主環境設定 SMILEWORK_ACTOR=<名稱>；模型可一併設定 SMILEWORK_MODEL=<模型名稱>。",
    );
  }
  if (actor.model === "unknown") {
    return warnCheck(
      "actor",
      `已設定 ${actor.name}，但未設定 SMILEWORK_MODEL`,
      "設定 SMILEWORK_MODEL=<模型名稱>，讓證據與審查能追到模型。",
    );
  }
  return okCheck("actor", `${actor.name}（${actor.model}）`);
}

function skillsCheck(skills: SkillHealth): DoctorCheck {
  if (skills.status === "not_configured") {
    return okCheck("技能連結", `沒有使用者層技能（${skills.source.path}），略過檢查`);
  }
  if (skills.status === "linked") {
    return okCheck(
      "技能連結",
      `已連結 ${skills.links.symlinks.length} 個技能到 ${skills.links.path}`,
    );
  }
  if (skills.status === "unavailable") {
    return warnCheck(
      "技能連結",
      `無法檢查：${skills.error ?? "未知錯誤"}`,
      `確認 ${skills.source.path} 與 ${skills.links.path} 的讀取權限。`,
    );
  }

  const problems: string[] = [];
  if (skills.links.broken.length > 0) problems.push(`斷鏈：${skills.links.broken.join("、")}`);
  if (skills.links.conflicts.length > 0) problems.push(`同名實體資料夾：${skills.links.conflicts.join("、")}`);
  if (skills.links.missing.length > 0) problems.push(`尚未連結：${skills.links.missing.join("、")}`);
  if (problems.length === 0 && skills.source.skills.length > 0) {
    problems.push(`尚未連結：${skills.source.skills.join("、")}`);
  }

  return warnCheck(
    "技能連結",
    `${problems.join("；") || "狀態不完整"}（${skills.links.path}）`,
    "執行 smilework link；專案層技能加上 --project <repo>。",
  );
}

function transcriptsCheck(transcripts: TranscriptHealth): DoctorCheck {
  if (transcripts.status === "ready") {
    return okCheck("對話索引", `可用（${transcripts.sizeBytes ?? 0} bytes）：${transcripts.path}`);
  }
  if (transcripts.status === "not_indexed") {
    return warnCheck(
      "對話索引",
      `尚未建立：${transcripts.path}`,
      "執行 smilework transcripts index 建立索引。",
    );
  }
  return warnCheck(
    "對話索引",
    `無法讀取：${transcripts.error ?? "未知錯誤"}（${transcripts.path}）`,
    "確認檔案權限，或移除損壞的索引後執行 smilework transcripts index --rebuild。",
  );
}

/** 收集所有檢查；任一子系統缺失都只形成警告，不讓 doctor 拋出例外。 */
export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const config = loadSmileworkConfig({ env, cwd });
  const report = inspectStatus({ env, cwd, config });

  const checks: DoctorCheck[] = [
    configCheck(env, config),
    databaseCheck(report.database),
    projectCheck(report.project),
    actorCheck(report.actor),
    skillsCheck(report.skills),
    transcriptsCheck(report.transcripts),
  ];

  const exitCode = checks.some((check) => check.status === "warn") ? 1 : 0;
  return { ok: exitCode === 0, checks, report, exitCode };
}

function printHuman(result: DoctorResult): void {
  const lines = [
    `SmileWork 健康檢查（${result.report.version.name} ${result.report.version.version}）`,
  ];
  for (const check of result.checks) {
    lines.push(`[${check.status === "ok" ? "ok" : "警告"}] ${check.name}：${check.detail}`);
    if (check.nextAction !== null) lines.push(`       下一步：${check.nextAction}`);
  }
  const passed = result.checks.filter((check) => check.status === "ok").length;
  const warned = result.checks.length - passed;
  lines.push("", `結果：${passed} 項通過、${warned} 項警告。`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export const command: Command = {
  description: "檢查環境與安裝狀態",
  run(args: readonly string[]): number {
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(USAGE);
      return 0;
    }

    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length > 0) {
      process.stderr.write(`不支援的參數：${unknown.join("、")}\n\n${USAGE}`);
      return 1;
    }

    const result = runDoctor();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      printHuman(result);
    }
    return result.exitCode;
  },
};
