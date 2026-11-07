import { CHECK_CODES, issueResult } from "./result.ts";
import type { CheckResult, SkillLayerConflictInput } from "./types.ts";

const CONFLICT_QUERY = `
  SELECT knowledge_id, title, layer
  FROM knowledge_entries
  WHERE status = 'active'
    AND kind = 'skill'
    AND layer = ?
    AND (knowledge_id = ? OR title = ?)
`;

/**
 * 技能在宿主載入時只看名稱，因此專案層與全域層不能同名。
 * 全域寫入預設比對所有專案；只有 scopeToProject 明確為 true 才縮限。
 * 這個檢查只查詢，不寫入資料庫。
 */
export function checkSkillLayerConflict(input: SkillLayerConflictInput): CheckResult {
  const oppositeLayer = input.layer === "project" ? "global" : "project";
  const scopedProject =
    input.layer === "global" &&
    input.scopeToProject === true &&
    typeof input.projectId === "string" &&
    input.projectId.length > 0
      ? input.projectId
      : null;

  const row =
    scopedProject === null
      ? input.db
          .query(`${CONFLICT_QUERY} LIMIT 1`)
          .get(oppositeLayer, input.name, input.name)
      : input.db
          .query(`${CONFLICT_QUERY} AND project_id = ? LIMIT 1`)
          .get(oppositeLayer, input.name, input.name, scopedProject);

  if (row === null || row === undefined) {
    return issueResult([]);
  }

  const layerLabel = oppositeLayer === "global" ? "全域" : "專案";
  return issueResult([
    {
      code: CHECK_CODES.skillNameConflict,
      field: "name",
      message: `技能名稱「${input.name}」已存在於${layerLabel}層；跨層同名會造成載入衝突。`,
    },
  ]);
}
