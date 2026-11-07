import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerPrompts } from "../prompts/index.ts";
import { registerResources } from "../resources/index.ts";
import { SERVER_NAME, SERVER_VERSION } from "../shared/version.ts";
import { buildServerInstructions } from "./instructions.ts";
import {
  loadSmileworkConfig,
  toolPresentation,
  type LoadConfigOptions,
  type SmileworkConfig,
} from "./profiles.ts";
import { TOOL_DEFINITIONS } from "./registry.ts";
import { runTool } from "./result.ts";
import { passThroughInputSchema } from "./validation.ts";

export const SERVER_INFO = {
  name: SERVER_NAME,
  version: SERVER_VERSION,
} as const;

export interface CreateMcpServerOptions extends LoadConfigOptions {
  /** 已解析的設定；startMcpServer 只載入一次，所有連線共用。 */
  config?: SmileworkConfig;
}

/**
 * 只掛載目前 profile 允許的工具。
 * registry 保留全部 21 個定義，實際暴露哪些由 profile 與設定決定。
 */
function registerProfileTools(server: McpServer, config: SmileworkConfig): void {
  const enabled = new Set(config.tools);
  for (const tool of TOOL_DEFINITIONS) {
    if (!enabled.has(tool.name)) continue;
    const presentation = toolPresentation(config.profile, tool);
    server.registerTool(
      tool.name,
      {
        title: presentation.title,
        description: presentation.description,
        inputSchema: passThroughInputSchema(tool.inputSchema),
      },
      async (input: unknown) => runTool(tool, (input ?? {}) as Record<string, unknown>),
    );
  }
}

/** 建立一個連線用的伺服器實例；serveStdio 每次連線會呼叫一次。 */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const config = options.config ?? loadSmileworkConfig(options);
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: buildServerInstructions(config.profile),
  });
  registerProfileTools(server, config);
  registerResources(server);
  registerPrompts(server);
  return server;
}

/**
 * 啟動 stdio 伺服器，直到宿主關閉 stdin 才結束。
 * stdout 是協定通道，任何提示只能寫到 stderr。
 */
export async function startMcpServer(options: CreateMcpServerOptions = {}): Promise<number> {
  const config = options.config ?? loadSmileworkConfig(options);
  for (const warning of config.warnings) {
    console.error(`[smilework] 設定警告：${warning}`);
  }

  const handle = serveStdio(() => createMcpServer({ ...options, config }), {
    onerror: (error) => {
      console.error(`[smilework] MCP 錯誤：${error.message}`);
    },
  });

  if (!process.stdin.readableEnded && !process.stdin.destroyed) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        process.stdin.off("end", done);
        process.stdin.off("close", done);
        resolve();
      };
      process.stdin.once("end", done);
      process.stdin.once("close", done);
    });
  }

  await handle.close();
  return 0;
}
