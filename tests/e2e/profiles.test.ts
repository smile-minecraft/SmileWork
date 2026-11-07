import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "../helpers/temp.ts";
import {
  countO200kTokens,
  createE2eProject,
  e2eEnvironment,
  sorted,
  startE2eServer,
} from "./helpers.ts";

const WORKER_TOOLS = [
  "knowledge_read",
  "knowledge_search",
  "signal_note",
  "status",
  "verify_run",
  "work_complete",
  "work_create",
  "work_get",
  "work_list",
  "work_ready",
  "work_review",
  "work_update",
] as const;

const CURATOR_TOOLS = [
  "knowledge_history",
  "knowledge_promote",
  "knowledge_read",
  "knowledge_revert",
  "knowledge_retire",
  "knowledge_search",
  "knowledge_write",
  "signal_list",
  "signal_mark",
  "signal_note",
  "status",
  "transcript_read",
  "transcript_search",
  "work_get",
  "work_list",
] as const;

const FULL_TOOLS = [...new Set([...WORKER_TOOLS, ...CURATOR_TOOLS])];

async function listNames(profile: string): Promise<{ names: string[]; payload: string }> {
  return await withTempDir(`e2e-profile-${profile}`, async (root) => {
    const home = join(root, "home", ".smilework");
    const project = await createE2eProject(root);
    const server = await startE2eServer(
      e2eEnvironment(home, project.repo, { profile, actor: "e2e-profile" }),
    );
    try {
      const listed = await server.client.listTools();
      return {
        names: listed.tools.map((tool) => tool.name).sort(),
        payload: JSON.stringify(listed),
      };
    } finally {
      await server.close();
    }
  });
}

describe("MCP 端對端：工具 profile", () => {
  test("worker 只看到 12 個工具，看不到對話紀錄", async () => {
    const { names } = await listNames("worker");
    expect(names).toHaveLength(12);
    expect(names).toEqual(sorted(WORKER_TOOLS));
    expect(names).not.toContain("transcript_search");
    expect(names).not.toContain("transcript_read");
  }, 30_000);

  test("curator 看得到對話與知識工具，不能建立、審查或結案工作", async () => {
    const { names } = await listNames("curator");
    expect(names).toHaveLength(15);
    expect(names).toEqual(sorted(CURATOR_TOOLS));
    for (const name of [
      "knowledge_write",
      "knowledge_history",
      "transcript_search",
      "transcript_read",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of [
      "work_create",
      "work_update",
      "work_complete",
      "work_review",
      "work_ready",
      "verify_run",
    ]) {
      expect(names).not.toContain(name);
    }
  }, 30_000);

  test("full 看到全部 21 個工具", async () => {
    const { names } = await listNames("full");
    expect(names).toHaveLength(21);
    expect(FULL_TOOLS).toHaveLength(21);
    expect(names).toEqual(sorted(FULL_TOOLS));
  }, 30_000);

  test("worker 的 tools/list 在 3000 token 以內", async () => {
    const { payload } = await listNames("worker");
    const chars4Estimate = Math.ceil(payload.length / 4);
    const exact = countO200kTokens(payload);
    // 量測方法：JSON.stringify(ListToolsResult)；有 o200k_base tokenizer 時精測，
    // 否則用固定 chars/4 比例估算，兩種都必須在預算內。
    expect(chars4Estimate).toBeLessThanOrEqual(3000);
    if (exact !== null) expect(exact).toBeLessThanOrEqual(3000);
  }, 30_000);
});
