import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { canTransition, WORK_STATUSES } from "../../src/domain/work.ts";
import { SIGNAL_KINDS, SIGNAL_STATUSES } from "../../src/domain/signal.ts";
import { KNOWLEDGE_KINDS, KNOWLEDGE_TYPES } from "../../src/domain/knowledge.ts";
import { smileworkDatabasePath, smileworkHome } from "../../src/shared/paths.ts";

describe("領域型別與狀態機", () => {
  test("工作狀態是匯出格式的六個值", () => {
    expect(WORK_STATUSES).toEqual(["open", "in_progress", "blocked", "review", "done", "cancelled"]);
  });

  test("非法狀態轉移被拒絕", () => {
    expect(canTransition("open", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "review")).toBe(true);
    expect(canTransition("review", "in_progress")).toBe(true);
    expect(canTransition("done", "in_progress")).toBe(false);
    expect(canTransition("cancelled", "open")).toBe(false);
    expect(canTransition("open", "done")).toBe(false);
  });

  test("訊號有六種 kind 與三種 status", () => {
    expect(SIGNAL_KINDS).toEqual([
      "correction",
      "failure",
      "fix",
      "review-reject",
      "lesson",
      "other",
    ]);
    expect(SIGNAL_STATUSES).toEqual(["new", "consumed", "dismissed"]);
  });

  test("知識 kind 與 type 分開定義", () => {
    expect(KNOWLEDGE_KINDS).toEqual(["memory", "skill", "document"]);
    expect(KNOWLEDGE_TYPES).toEqual(["decision", "reference", "lesson", "pitfall", "preference", "document"]);
  });
});

describe("SMILEWORK_HOME", () => {
  test("預設是使用者家目錄下的 .smilework", () => {
    expect(smileworkHome({})).toBe(join(homedir(), ".smilework"));
    expect(smileworkDatabasePath({})).toBe(join(homedir(), ".smilework", "smilework.db"));
  });

  test("環境變數優先，並解析成絕對路徑", () => {
    expect(smileworkHome({ SMILEWORK_HOME: "/tmp/smilework-test" })).toBe("/tmp/smilework-test");
    expect(smileworkDatabasePath({ SMILEWORK_HOME: "/tmp/smilework-test" })).toBe(
      "/tmp/smilework-test/smilework.db",
    );
  });
});
