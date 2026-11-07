import { UNKNOWN_ACTOR, type Actor } from "../domain/actor.ts";

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** actor 只用於歸屬與稽核；未設定時記為 unknown，並由 hint 提示怎麼設定。 */
export function resolveActor(env: NodeJS.ProcessEnv = process.env): Actor {
  const name = configured(env.SMILEWORK_ACTOR);
  const model = configured(env.SMILEWORK_MODEL);
  if (name === null && model === null) return UNKNOWN_ACTOR;
  return {
    name: name ?? "unknown",
    model: model ?? "unknown",
    declared: name !== null,
  };
}

export function actorHint(actor: Actor): string | null {
  if (!actor.declared) {
    return "未設定 SMILEWORK_ACTOR，這次操作會記為 unknown。請在宿主環境設定 SMILEWORK_ACTOR=<名稱>。";
  }
  if (actor.model === "unknown") {
    return "未設定 SMILEWORK_MODEL，這次操作會記為 unknown 模型。";
  }
  return null;
}
