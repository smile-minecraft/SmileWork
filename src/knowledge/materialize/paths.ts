import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { KnowledgeLayer } from "../../domain/knowledge.ts";
import { invalidKnowledgeInput } from "./errors.ts";

const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * 預設 SMILEWORK_HOME 是 `~/.smilework`，因此從它反推使用者家目錄；
 * 自訂到其他位置時才退回目前程序的家目錄。
 */
export function resolveUserHome(smileworkHome: string): string {
  const base = basename(resolve(smileworkHome));
  if (base === ".smilework") return dirname(resolve(smileworkHome));
  const configured = process.env.HOME?.trim();
  return configured ? resolve(configured) : homedir();
}

/** 從已開啟的資料庫檔反推 SMILEWORK_HOME；記憶體資料庫才退回環境變數。 */
export function smileworkHomeForDatabase(db: Database): string {
  const filename = db.filename;
  if (filename && filename !== ":memory:" && isAbsolute(filename)) return dirname(filename);
  const configured = process.env.SMILEWORK_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".smilework");
}

export function assertPathSegment(value: string, field: string): string {
  if (!PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw invalidKnowledgeInput(
      `${field} 只能包含英文字母、數字、句點、底線與連字號：${value}`,
      "改用不含路徑分隔符的名稱。",
      { field, value },
    );
  }
  return value;
}

/** 統一附檔路徑：只接受根目錄以下的相對路徑，並拒絕逃逸與不明確的形式。 */
export function normalizeRelativeFilePath(input: string, field = "files"): string {
  const reject = (message: string, nextAction = "提供相對於知識根目錄的實體檔案路徑。"): never => {
    throw invalidKnowledgeInput(message, nextAction, { field, path: input });
  };

  const raw = input.trim();
  if (raw.length === 0 || raw.includes("\0")) {
    reject("附檔路徑不能是空字串。");
  }
  if (raw.includes("\\")) {
    reject(`附檔路徑不能包含反斜線：${input}`, "改用正斜線 `/` 分隔路徑。");
  }
  if (raw.endsWith("/")) {
    reject(`附檔路徑不能以斜線結尾：${input}`, "移除結尾斜線；附檔路徑必須指向檔案。");
  }
  if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    reject(`附檔路徑不能是絕對路徑：${input}`, "改用相對於知識根目錄的路徑。");
  }
  if (raw.split("/").some((part) => part === "..")) {
    reject(`附檔路徑不能包含 ..：${input}`, "改用根目錄以下的相對路徑。");
  }
  if (raw.split("/").some((part) => part === ".")) {
    reject(`附檔路徑不能包含 . 路徑段：${input}`, "移除 `.` 路徑段，直接寫出檔案路徑。");
  }

  const normalized = posix.normalize(raw).replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/")
  ) {
    reject(`附檔路徑不是有效的檔案路徑：${input}`, "改用根目錄以下、指向檔案的路徑。");
  }

  return normalized;
}

export function memoryRoot(
  smileworkHome: string,
  layer: KnowledgeLayer,
  projectId: string | null,
): string {
  if (layer === "global") return join(smileworkHome, "memory");
  if (!projectId) {
    throw invalidKnowledgeInput("專案記憶缺少 projectId。", "先解析專案後再寫入記憶。", {
      field: "layer",
    });
  }
  return join(smileworkHome, "memory", "projects", assertPathSegment(projectId, "projectId"));
}

export function memoryTopicPath(
  smileworkHome: string,
  layer: KnowledgeLayer,
  projectId: string | null,
  knowledgeId: string,
): string {
  return join(
    memoryRoot(smileworkHome, layer, projectId),
    "topics",
    `${assertPathSegment(knowledgeId, "knowledgeId")}.md`,
  );
}

export function memoryFilesRoot(
  smileworkHome: string,
  layer: KnowledgeLayer,
  projectId: string | null,
  knowledgeId: string,
): string {
  return join(
    memoryRoot(smileworkHome, layer, projectId),
    "files",
    assertPathSegment(knowledgeId, "knowledgeId"),
  );
}

export function skillRoot(home: string, projectPath: string | null, layer: KnowledgeLayer): string {
  if (layer === "global") return join(home, ".agents", "skills");
  if (!projectPath) {
    throw invalidKnowledgeInput("專案技能缺少專案路徑。", "提供 projectPath 或設定 SMILEWORK_PROJECT。", {
      field: "projectPath",
    });
  }
  return join(projectPath, ".agents", "skills");
}

export function skillArtifactPath(
  home: string,
  projectPath: string | null,
  layer: KnowledgeLayer,
  knowledgeId: string,
): string {
  return join(
    skillRoot(home, projectPath, layer),
    assertPathSegment(knowledgeId, "knowledgeId"),
  );
}

export function archiveRoot(smileworkHome: string): string {
  return join(smileworkHome, "knowledge-archive");
}

/** 需要把專案層檔案併到同一棵封存樹時，用 projectId 當區隔。 */
export function archiveLayerSegment(
  layer: KnowledgeLayer,
  projectId: string | null,
): string[] {
  if (layer === "global") return ["global"];
  if (!projectId) return ["project", "unknown"];
  return ["projects", assertPathSegment(projectId, "projectId")];
}
