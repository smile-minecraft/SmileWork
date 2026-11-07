import { existsSync } from "node:fs";
import { runTool } from "../../../src/mcp/result.ts";
import { tool } from "../../../src/tools/knowledge/write.ts";

const goFile = process.env.GO_FILE;
if (!goFile) throw new Error("缺少 GO_FILE。");
while (!existsSync(goFile)) {
  await Bun.sleep(5);
}

const layer = process.env.WRITE_LAYER;
if (layer !== "project" && layer !== "global") throw new Error(`不支援的 layer：${layer}`);

const content = [
  "---",
  "name: race-skill",
  "description: 競態測試技能",
  "---",
  "",
  "# Race",
].join("\n");

const result = await runTool(
  tool,
  {
    kind: "skill",
    layer,
    knowledgeId: "race-skill",
    title: "競態測試",
    description: "競態測試技能",
    content,
  },
  { env: process.env, cwd: process.env.SMILEWORK_PROJECT, registerProject: false },
);

const block = result.content[0];
process.stdout.write(block?.type === "text" ? block.text : "");
