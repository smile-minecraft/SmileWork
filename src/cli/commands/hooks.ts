import type { Command } from "../command.ts";

export const command: Command = {
  description: "管理代理掛鉤",
  run(): number {
    console.log("hooks：尚未實作");
    return 0;
  },
};
