import type { Command } from "./command.ts";
import { commands } from "./commands/index.ts";

function renderHelp(): string {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  const commandLines = Object.entries(commands)
    .map(([name, command]) => `  ${name.padEnd(width)}  ${command.description}`)
    .join("\n");

  return [
    "SmileWork：跨代理共用的本機 MCP 伺服器",
    "",
    "用法：",
    "  smilework <子命令> [參數]",
    "",
    "子命令：",
    commandLines,
    "",
    "選項：",
    "  -h, --help  顯示這份說明",
    "",
  ].join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined || name === "--help" || name === "-h") {
    process.stdout.write(renderHelp());
    return 0;
  }

  const command: Command | undefined = commands[name];
  if (command === undefined) {
    process.stderr.write(`未知的子命令：${name}\n\n${renderHelp()}`);
    return 1;
  }

  return await command.run(args);
}
