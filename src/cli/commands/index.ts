import type { Command } from "../command.ts";
import { command as doctor } from "./doctor.ts";
import { command as exportCommand } from "./export.ts";
import { command as exportV3 } from "./exportV3.ts";
import { command as hooks } from "./hooks.ts";
import { command as importCommand } from "./import.ts";
import { command as link } from "./link.ts";
import { command as mcp } from "./mcp.ts";
import { command as project } from "./project.ts";
import { command as transcripts } from "./transcripts.ts";
import { command as usage } from "./usage.ts";

/** CLI 對外的子命令清單，鍵就是使用者輸入的名稱。 */
export const commands: Readonly<Record<string, Command>> = {
  mcp,
  "export-v3": exportV3,
  import: importCommand,
  export: exportCommand,
  link,
  transcripts,
  doctor,
  hooks,
  usage,
  project,
};
