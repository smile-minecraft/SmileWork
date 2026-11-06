import type { Command } from "../command.ts";
import { runExportV3 } from "../../export/v3/cli.ts";

export const command: Command = {
  description: "把舊版 ultrawork 資料匯出成 smilework-export v1",
  run(args: readonly string[]): number {
    return runExportV3(args);
  },
};
