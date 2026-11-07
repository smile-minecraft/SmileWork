import type { Command } from "../command.ts";
import { startMcpServer } from "../../mcp/server.ts";

export const command: Command = {
  description: "啟動 MCP stdio 伺服器",
  run(): Promise<number> {
    return startMcpServer();
  },
};
