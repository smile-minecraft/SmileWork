import { describe, expect, test } from "bun:test";
import type { GetPromptResult } from "@modelcontextprotocol/server";
import { callToolJson, createSurfaceEnv, startSurfaceServer } from "./helpers.ts";
import { withTempHome } from "../helpers/temp.ts";

interface CreatedWork {
  id: string;
  title: string;
}

function messageText(result: GetPromptResult): string {
  const content = result.messages[0]?.content;
  if (content === undefined || content.type !== "text") {
    throw new Error("prompt 沒有回傳文字訊息。");
  }
  return content.text;
}

describe("MCP prompts", () => {
  test("三個 prompts 都列出參數，並能產生內容", async () => {
    await withTempHome("mcp-surface-prompts", async (home, root) => {
      const prepared = await createSurfaceEnv({ root, home, profile: "full" });
      const server = await startSurfaceServer(prepared.env);
      try {
        const listed = await server.client.listPrompts();
        const names = listed.prompts.map((prompt) => prompt.name).sort();
        expect(names).toEqual(["brief", "consolidate", "review"]);

        const briefArguments = listed.prompts
          .find((prompt) => prompt.name === "brief")
          ?.arguments?.map((argument) => argument.name);
        expect(briefArguments).toContain("workId");

        const created = await callToolJson(server.client, "work_create", {
          title: "簡報與審查測試",
          objective: "確認 prompt 會帶入工作內容。",
          acceptance: ["brief 含驗收條件", "review 含審查結論"],
          risk: "low",
        });
        const work = created.data.work as CreatedWork;

        const brief = await server.client.getPrompt({
          name: "brief",
          arguments: { workId: work.id },
        });
        const briefText = messageText(brief);
        expect(briefText).toContain("簡報與審查測試");
        expect(briefText).toContain("brief 含驗收條件");
        expect(briefText).toContain("work_update");

        const review = await server.client.getPrompt({
          name: "review",
          arguments: { workId: work.id, focus: "檢查證據是否可重現" },
        });
        const reviewText = messageText(review);
        expect(reviewText).toContain("簡報與審查測試");
        expect(reviewText).toContain("檢查證據是否可重現");
        expect(reviewText).toContain("approve");
        expect(reviewText).toContain("reject");

        const consolidate = await server.client.getPrompt({
          name: "consolidate",
          arguments: { scope: "global" },
        });
        const consolidateText = messageText(consolidate);
        expect(consolidateText).toContain("knowledge_search");
        expect(consolidateText).toContain("knowledge_write");
        expect(consolidateText).toContain("signal_list");
      } finally {
        await server.close();
      }
    });
  }, 30_000);
});
