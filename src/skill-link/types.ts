/** 技能來源層：使用者層或專案層。 */
export type SkillLayer = "global" | "project";

/** 可以掛載技能連結的宿主。 */
export type SkillHost = "claude" | "pi";

export interface SkillHostSummary {
  readonly host: SkillHost;
  readonly globalLinkRoot: string;
  readonly projectLinkRoot: string | null;
}

/** 掃描技能根目錄的結果。 */
export interface SkillsRootScan {
  /** 技能根目錄的絕對路徑。 */
  readonly root: string;
  /** 根目錄是否存在。 */
  readonly exists: boolean;
  /** 目錄名稱即技能 ID，已排序。 */
  readonly skills: readonly string[];
}

/** 單一技能的連結結果。dry-run 時 outcome 代表「預計」的結果。 */
export interface SkillLinkResult {
  readonly name: string;
  readonly layer: SkillLayer;
  readonly host: SkillHost;
  /** 技能實體位置，也就是 symlink 指向的來源。 */
  readonly sourcePath: string;
  /** 建立在該層宿主技能根目錄下的 symlink 路徑。 */
  readonly linkPath: string;
  /** 實際或預計寫入的 target；既有連結則是目前 readlink 的值。 */
  readonly target?: string;
  readonly outcome: "created" | "skipped" | "conflict";
  /** 衝突或略過的原因；建立成功時沒有這個欄位。 */
  readonly reason?: string;
}

/** 兩層都有同名技能時的對照紀錄；兩邊各自連結，不互相覆蓋。 */
export interface CrossLayerSkill {
  readonly name: string;
  readonly host: SkillHost;
  readonly globalSourcePath: string;
  readonly projectSourcePath: string;
  readonly globalLinkPath: string;
  readonly projectLinkPath: string;
}

export interface SkillSourceSummary {
  readonly layer: SkillLayer;
  readonly root: string;
  readonly exists: boolean;
  readonly skillCount: number;
}

export interface SkillLinkSummary {
  readonly home: string;
  /** Claude Code 的使用者層連結根目錄，保留給既有呼叫端。 */
  readonly globalLinkRoot: string;
  /** Claude Code 的專案層連結根目錄，有 --project 時是 <repo>/.claude/skills。 */
  readonly projectLinkRoot: string | null;
  readonly projectPath: string | null;
  readonly dryRun: boolean;
  readonly sources: readonly SkillSourceSummary[];
  /** 這次實際處理的宿主與各自的連結根目錄。 */
  readonly hosts: readonly SkillHostSummary[];
  readonly results: readonly SkillLinkResult[];
  /** 兩層同名技能的清單；每一層、每個宿主各自連結，不互相覆蓋。 */
  readonly overlaps: readonly CrossLayerSkill[];
}
