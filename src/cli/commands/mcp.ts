import type { Command } from "../command.ts";

export const command: Command = {
  description: "啟動 MCP stdio 伺服器",
  run(): number {
    // stdout 是 MCP 的協定通道，提示訊息只能寫到 stderr。
    console.error("mcp：尚未實作");
    return 0;
  },
};
