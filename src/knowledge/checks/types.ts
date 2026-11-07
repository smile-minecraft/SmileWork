import type { Database } from "bun:sqlite";
import type { KnowledgeKind, KnowledgeLayer } from "../../domain/knowledge.ts";

export type CheckSeverity = "error" | "warning";

/** 單一檢查問題；`field` 指向輸入欄位，讓呼叫端能直接回報是哪個欄位不合格。 */
export interface CheckIssue {
  code: string;
  field: string;
  message: string;
  /** 問題所在的檔案，例如 `SKILL.md`。 */
  path?: string;
  /** 問題所在的行號，從 1 開始。 */
  line?: number;
}

export interface CheckResult {
  ok: boolean;
  errors: CheckIssue[];
  warnings: CheckIssue[];
}

export interface KnowledgeFile {
  path: string;
  content: string | Uint8Array;
}

/** 參與大小預算計算的內容片段；`field` 用來指出超額時是哪個欄位。 */
export interface SizedContent {
  content: string | Uint8Array;
  field?: string;
}

/** 掃描用的文字欄位；`field` 是回報時的欄位名稱，`path` 是檔案位置。 */
export interface TextField {
  field: string;
  path?: string;
  content: string;
}

export interface SizeBudget {
  /** 整份內容的位元組上限。 */
  maxBytes: number;
  /** 超過上限時要阻擋或只警告，預設 error。 */
  severity?: CheckSeverity;
}

export interface CheckOptions {
  /** 技能名稱長度上限，預設 64。 */
  maxNameLength?: number;
  /** 技能描述長度上限，預設 1024。 */
  maxDescriptionLength?: number;
  /** SKILL.md 行數警告門檻，預設 500。 */
  maxSkillMarkdownLines?: number;
  /** 大小預算；省略時使用 256 KiB。 */
  sizeBudget?: SizeBudget;
  /** 危險模式的嚴重程度，預設 warning。 */
  dangerousSeverity?: CheckSeverity;
}

export interface SkillNameInput {
  name: string;
  /** 技能資料夾名稱；省略時只驗證名稱本身。 */
  directoryName?: string;
}

export interface KnowledgeCheckInput {
  kind: KnowledgeKind;
  name: string;
  /** 知識標題；寫入工具可以提供，機密掃描會涵蓋。 */
  title?: string;
  description?: string;
  layer: KnowledgeLayer;
  /** 寫入的專案；跨層同名預設比對所有專案，這個值只用於回報與明確縮限。 */
  projectId?: string | null;
  /** 技能資料夾名稱；技能檢查必須提供。 */
  directoryName?: string;
  files?: readonly KnowledgeFile[];
}

export interface KnowledgeCheckContext {
  /** 提供時才查詢跨層同名；檢查本身不寫入資料庫。 */
  db?: Database;
  options?: CheckOptions;
}

export interface SkillLayerConflictInput {
  db: Database;
  name: string;
  layer: KnowledgeLayer;
  /** 目前專案；只在 scopeToProject 為 true 時用來縮限比對範圍。 */
  projectId?: string | null;
  /**
   * 明確開啟時，全域寫入只比對指定專案。預設 false，會比對所有專案，
   * 因為同名的專案技能在任何專案載入時都可能與全域技能衝突。
   */
  scopeToProject?: boolean;
}
