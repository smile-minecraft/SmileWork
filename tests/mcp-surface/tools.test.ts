import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import {
  CURATOR_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  countO200kTokens,
  createSurfaceEnv,
  startSurfaceServer,
} from "./helpers.ts";
import { withTempHome } from "../helpers/temp.ts";

async function withProfile<T>(
  profile: string | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return await withTempHome("mcp-surface-tools", async (home, root) => {
    const prepared = await createSurfaceEnv({ root, home, profile });
    const server = await startSurfaceServer(prepared.env);
    try {
      return await run(server.client);
    } finally {
      await server.close();
    }
  });
}

async function toolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name).sort();
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("MCP tools/list 依 profile 篩選", () => {
  test("worker 只看到 12 個工具，而且沒有對話紀錄工具", async () => {
    await withProfile("worker", async (client) => {
      const names = await toolNames(client);
      expect(names).toHaveLength(12);
      expect(names).toEqual(sorted(WORKER_TOOL_NAMES));
      expect(names).not.toContain("transcript_search");
      expect(names).not.toContain("transcript_read");
    });
  });

  test("未設定 profile 與設定檔時預設 worker 12 個工具", async () => {
    await withProfile(undefined, async (client) => {
      const names = await toolNames(client);
      expect(names).toHaveLength(12);
      expect(names).toEqual(sorted(WORKER_TOOL_NAMES));
      expect(names).not.toContain("transcript_search");
    });
  });

  test("curator 只看到 15 個工具，而且不能建立或修改工作", async () => {
    await withProfile("curator", async (client) => {
      const names = await toolNames(client);
      expect(names).toHaveLength(15);
      expect(names).toEqual(sorted(CURATOR_TOOL_NAMES));
      for (const hidden of [
        "work_create",
        "work_update",
        "work_complete",
        "work_review",
        "work_ready",
        "verify_run",
      ]) {
        expect(names).not.toContain(hidden);
      }
    });
  });

  test("full 看到全部 21 個工具", async () => {
    await withProfile("full", async (client) => {
      const names = await toolNames(client);
      expect(names).toHaveLength(21);
      expect(names).toContain("transcript_search");
      expect(names).toContain("work_create");
      expect(names).toContain("verify_run");
    });
  });

  test("專案設定只能縮減工具，不能改 profile", async () => {
    await withTempHome("mcp-surface-project-config", async (home, root) => {
      const prepared = await createSurfaceEnv({ root, home });
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "config.jsonc"), `{"profile": "full"}\n`, "utf8");
      await writeFile(
        join(prepared.repo, ".smilework.jsonc"),
        `{"profile": "worker", "disabledTools": ["transcript_search"]}\n`,
        "utf8",
      );

      const server = await startSurfaceServer(prepared.env);
      try {
        const names = await toolNames(server.client);
        expect(names).toHaveLength(20);
        expect(names).not.toContain("transcript_search");
      } finally {
        await server.close();
      }
    });
  });
});

describe("伺服器說明", () => {
  test("三個 profile 的 instructions 都在 800 字元內，而且各有三個行為提示", async () => {
    for (const profile of ["worker", "curator", "full"] as const) {
      await withProfile(profile, async (client) => {
        const instructions = client.getInstructions();
        expect(instructions).toBeTruthy();
        const text = instructions ?? "";
        expect(text.length).toBeLessThanOrEqual(800);

        const hints = text.split("\n").filter((line) => /^[1-3]\.\s/.test(line));
        expect(hints).toHaveLength(3);

        const mentioned = new Set(
          [...text.matchAll(/\b(?:work|knowledge|signal|transcript)_[a-z_]+|\bverify_run\b/g)].map(
            (match) => match[0],
          ),
        );
        const listed = await toolNames(client);
        for (const name of mentioned) {
          expect(listed).toContain(name);
        }
      });
    }
  });
});

describe("worker 的 tools/list 預算", () => {
  test("序列化後的 tools/list 在 3000 token 以內", async () => {
    await withProfile("worker", async (client) => {
      const listed = await client.listTools();
      const payload = JSON.stringify(listed);
      const chars4Estimate = Math.ceil(payload.length / 4);
      const exact = countO200kTokens(payload);

      // 固定比例估算用 spike 相同的 chars/4；有 gpt-tokenizer 時以 o200k_base 精測。
      expect(chars4Estimate).toBeLessThanOrEqual(3000);
      if (exact !== null) {
        expect(exact).toBeLessThanOrEqual(3000);
      }
      expect(exact ?? chars4Estimate).toBeLessThanOrEqual(3000);
    });
  });
});
