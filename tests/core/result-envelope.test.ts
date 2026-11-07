import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { runTool } from "../../src/mcp/result.ts";
import type { ToolDefinition } from "../../src/mcp/types.ts";
import { SmileworkError } from "../../src/shared/errors.ts";
import { failureFromError, fail, ok } from "../../src/shared/result.ts";
import { withTempDir } from "../helpers/temp.ts";

describe("固定結果外框", () => {
  test("成功外框固定為 ok、summary、data", () => {
    const result = ok("完成", { id: "work-1" });

    expect(result).toEqual({ ok: true, summary: "完成", data: { id: "work-1" } });
    expect(Object.keys(result).sort()).toEqual(["data", "ok", "summary"]);
  });

  test("失敗外框固定為 ok、code、message、nextAction、data", () => {
    const result = fail("VERSION_CONFLICT", "版本不符", "重新讀取後再更新。", { version: 2 });

    expect(result).toEqual({
      ok: false,
      code: "VERSION_CONFLICT",
      message: "版本不符",
      nextAction: "重新讀取後再更新。",
      data: { version: 2 },
    });
    expect(Object.keys(result).sort()).toEqual(["code", "data", "message", "nextAction", "ok"]);
  });

  test("失敗外框的 data 預設為空物件", () => {
    expect(fail("INVALID_INPUT", "格式錯誤", "修正參數。").data).toEqual({});
  });

  test("SmileworkError 轉成固定的失敗外框", () => {
    const result = failureFromError(
      new SmileworkError("PATH_NOT_ALLOWED", "路徑不在允許範圍", "改用允許的根目錄。", { path: "/etc" }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "PATH_NOT_ALLOWED",
      message: "路徑不在允許範圍",
      nextAction: "改用允許的根目錄。",
      data: { path: "/etc" },
    });
  });

  test("未知例外一律轉成 INTERNAL_ERROR，不吞掉訊息", () => {
    const result = failureFromError(new Error("boom"));

    expect(result.ok).toBe(false);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toContain("boom");
  });

  test("需要專案的 handler 無法解析時回 PROJECT_REQUIRED 外框", async () => {
    await withTempDir("tool-project-required", async (cwd) => {
      const tool: ToolDefinition = {
        name: "write_probe",
        title: "寫入探針",
        description: "測試用",
        domain: "work",
        inputSchema: z.object({}),
        handler: (_input, context) => {
          context.resolveProject();
          return ok("不該到這裡", {});
        },
      };

      const call = await runTool(tool, {}, { env: {}, cwd });
      const content = call.content[0];
      const text = content?.type === "text" ? content.text : "";
      const payload = JSON.parse(text) as Record<string, unknown>;

      expect(call.isError).toBe(true);
      expect(payload).toMatchObject({ ok: false, code: "PROJECT_REQUIRED" });
      expect(typeof payload.nextAction).toBe("string");
    });
  });
});
