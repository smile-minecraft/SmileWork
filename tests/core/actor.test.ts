import { describe, expect, test } from "bun:test";
import { createToolContext } from "../../src/mcp/context.ts";
import { actorHint, resolveActor } from "../../src/project/actor.ts";
import { UNKNOWN_ACTOR } from "../../src/domain/actor.ts";

describe("actor 解析", () => {
  test("未設定時記為 unknown 並提供提示", () => {
    const actor = resolveActor({});

    expect(actor).toEqual(UNKNOWN_ACTOR);
    expect(actor.name).toBe("unknown");
    expect(actor.model).toBe("unknown");
    expect(actor.declared).toBe(false);
    expect(actorHint(actor)).toContain("SMILEWORK_ACTOR");
  });

  test("只設定 actor 時 model 仍是 unknown", () => {
    const actor = resolveActor({ SMILEWORK_ACTOR: "build" });

    expect(actor.name).toBe("build");
    expect(actor.model).toBe("unknown");
    expect(actor.declared).toBe(true);
    expect(actorHint(actor)).toContain("SMILEWORK_MODEL");
  });

  test("兩個變數都設定時不顯示提示", () => {
    const actor = resolveActor({ SMILEWORK_ACTOR: "build", SMILEWORK_MODEL: "gpt-5" });

    expect(actor).toEqual({ name: "build", model: "gpt-5", declared: true });
    expect(actorHint(actor)).toBeNull();
  });

  test("空白值視為未設定", () => {
    const actor = resolveActor({ SMILEWORK_ACTOR: "   ", SMILEWORK_MODEL: "" });

    expect(actor.name).toBe("unknown");
    expect(actor.model).toBe("unknown");
  });

  test("工具 context 會帶上 actor 與提示", () => {
    const context = createToolContext({ env: {}, cwd: "/tmp", registerProject: false });
    try {
      expect(context.actor).toEqual(UNKNOWN_ACTOR);
      expect(context.actorHint).toContain("SMILEWORK_ACTOR");
    } finally {
      context.close();
    }
  });
});
