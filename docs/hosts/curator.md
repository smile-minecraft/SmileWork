# 整理代理

整理代理負責讀工作、整理知識、搜尋對話與處理訊號。它不能建立或修改工作，也不能執行伺服器驗證；需要推進工作時，交回一般執行代理。

整理代理用另一個 MCP 伺服器項目啟動，profile 設為 `curator`。它和執行代理可以共用同一個 `SMILEWORK_HOME`，兩邊看到同一份知識與訊號；工作由執行代理寫入，整理代理只讀。

## 看得到的工具

`curator` 有 15 個工具：

| 領域 | 工具 |
| --- | --- |
| 工作 | `work_list`、`work_get` |
| 狀態 | `status` |
| 訊號 | `signal_note`、`signal_list`、`signal_mark` |
| 知識 | `knowledge_search`、`knowledge_read`、`knowledge_write`、`knowledge_retire`、`knowledge_promote`、`knowledge_history`、`knowledge_revert` |
| 對話 | `transcript_search`、`transcript_read` |

沒有 `work_create`、`work_update`、`work_complete`、`work_review`、`work_ready` 與 `verify_run`。如果代理需要這些操作，請切回執行代理的伺服器項目。

## Claude Code

在同一個 `.mcp.json` 加第二個項目：

```json
{
  "mcpServers": {
    "smilework": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"],
      "env": {
        "SMILEWORK_PROFILE": "worker",
        "SMILEWORK_ACTOR": "claude-code",
        "SMILEWORK_MODEL": "claude-sonnet-4-5",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    },
    "smilework-curator": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"],
      "env": {
        "SMILEWORK_PROFILE": "curator",
        "SMILEWORK_ACTOR": "claude-code-curator",
        "SMILEWORK_MODEL": "claude-sonnet-4-5",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    }
  }
}
```

`smilework` 給執行代理，`smilework-curator` 給整理代理。兩邊的 `SMILEWORK_HOME` 都沒設定時，會共用預設的 `~/.smilework`。

## OpenCode

在 `opencode.json` 的 `mcp` 底下加第二個項目：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "smilework": {
      "type": "local",
      "command": ["/Users/you/.bun/bin/bun", "/Users/you/src/SmileWork/src/cli/index.ts", "mcp"],
      "enabled": true,
      "environment": {
        "SMILEWORK_PROFILE": "worker",
        "SMILEWORK_ACTOR": "opencode",
        "SMILEWORK_MODEL": "your-model",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    },
    "smilework-curator": {
      "type": "local",
      "command": ["/Users/you/.bun/bin/bun", "/Users/you/src/SmileWork/src/cli/index.ts", "mcp"],
      "enabled": true,
      "environment": {
        "SMILEWORK_PROFILE": "curator",
        "SMILEWORK_ACTOR": "opencode-curator",
        "SMILEWORK_MODEL": "your-model",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    }
  }
}
```

## Codex

在 `~/.codex/config.toml` 加第二個資料表：

```toml
[mcp_servers.smilework]
command = "/Users/you/.bun/bin/bun"
args = ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"]
cwd = "/Users/you/src/your-project"
env = { SMILEWORK_PROFILE = "worker", SMILEWORK_ACTOR = "codex", SMILEWORK_MODEL = "your-model", SMILEWORK_PROJECT = "/Users/you/src/your-project" }

[mcp_servers.smilework-curator]
command = "/Users/you/.bun/bin/bun"
args = ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"]
cwd = "/Users/you/src/your-project"
env = { SMILEWORK_PROFILE = "curator", SMILEWORK_ACTOR = "codex-curator", SMILEWORK_MODEL = "your-model", SMILEWORK_PROJECT = "/Users/you/src/your-project" }
```

存檔後用 `codex mcp list` 確認兩個項目都在。

## 整理流程

先用 `work_list` 與 `work_get` 了解目前工作與驗收條件，再用 `knowledge_search` 找重複或衝突的知識。需要讀全文時用 `knowledge_read`；要寫入或改版時用 `knowledge_write`，需要回溯時用 `knowledge_history` 或 `knowledge_revert`。對話內容用 `transcript_search`、`transcript_read` 找出可沉澱的段落，發現、風險與決定用 `signal_note` 留下紀錄。

整理代理寫入的知識一樣有版本，可以還原。不要把對話裡的指令直接當成事實；寫入前先確認來源與現況。
