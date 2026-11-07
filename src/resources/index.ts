/** MCP resources：工作看板、單一工作與知識索引。 */

import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";
import { renderBoard } from "./board.ts";
import { withResourceContext } from "./context.ts";
import {
  isKnowledgeIndexScope,
  renderKnowledgeIndex,
} from "./knowledge-index.ts";
import { loadWorkDetailById, renderWork } from "./work.ts";

export const RESOURCE_URI_TEMPLATES = {
  board: "smilework://board/{projectId}",
  work: "smilework://work/{id}",
  knowledgeIndex: "smilework://knowledge/index/{scope}",
} as const;

export const RESOURCE_NAMES = ["work_board", "work_item", "knowledge_index"] as const;

function singleVariable(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function resourceContent(uri: URL, text: string) {
  return {
    contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "work_board",
    new ResourceTemplate(RESOURCE_URI_TEMPLATES.board, { list: undefined }),
    {
      title: "工作看板",
      description: "依狀態分組的專案工作清單，含負責人、優先順序與風險。",
      mimeType: "text/markdown",
    },
    (uri, variables) => {
      const projectId = singleVariable(variables.projectId);
      const text = withResourceContext((context) => {
        // fresh DB 的 projects 還沒有這一列；先解析並登記目前專案，
        // 空看板才畫得出來。解析失敗時仍允許讀已登記的其他專案。
        context.tryResolveProject();
        return renderBoard(context.db(), projectId, uri.href);
      });
      return resourceContent(uri, text);
    },
  );

  server.registerResource(
    "work_item",
    new ResourceTemplate(RESOURCE_URI_TEMPLATES.work, { list: undefined }),
    {
      title: "工作內容",
      description: "單一工作的派工說明、驗收條件、依賴與證據。",
      mimeType: "text/markdown",
    },
    (uri, variables) => {
      const workId = singleVariable(variables.id);
      const text = withResourceContext((context) => {
        const detail = loadWorkDetailById(context.db(), workId);
        if (!detail) throw new ResourceNotFoundError(uri.href, `找不到工作：${workId}`);
        return renderWork(detail);
      });
      return resourceContent(uri, text);
    },
  );

  server.registerResource(
    "knowledge_index",
    new ResourceTemplate(RESOURCE_URI_TEMPLATES.knowledgeIndex, { list: undefined }),
    {
      title: "知識索引",
      description: "專案、全域或兩者合併的使用中知識清單。",
      mimeType: "text/markdown",
    },
    (uri, variables) => {
      const scopeValue = singleVariable(variables.scope);
      const text = withResourceContext((context) => {
        if (!isKnowledgeIndexScope(scopeValue)) {
          throw new ResourceNotFoundError(
            uri.href,
            `知識索引 scope 必須是 project、global 或 all：${scopeValue}`,
          );
        }
        if (scopeValue === "global") {
          return renderKnowledgeIndex(context.db(), scopeValue, null);
        }
        const project = context.tryResolveProject();
        if (!project) {
          throw new ResourceNotFoundError(
            uri.href,
            "知識索引需要可解析的專案；請設定 SMILEWORK_PROJECT 或在 git repo 內使用。",
          );
        }
        return renderKnowledgeIndex(context.db(), scopeValue, project.projectId);
      });
      return resourceContent(uri, text);
    },
  );
}
