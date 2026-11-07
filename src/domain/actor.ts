/** 代理身分；只用於歸屬與稽核，不是安全邊界。 */
export interface Actor {
  readonly name: string;
  readonly model: string;
  readonly declared: boolean;
}

export const UNKNOWN_ACTOR: Actor = Object.freeze({
  name: "unknown",
  model: "unknown",
  declared: false,
});
