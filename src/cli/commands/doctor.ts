import type { Command } from "../command.ts";

export const command: Command = {
  description: "檢查環境與安裝狀態",
  run(): number {
    console.log("doctor：尚未實作");
    return 0;
  },
};
