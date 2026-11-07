# OpenCode

OpenCode 從專案的 `opencode.json` 或 `opencode.jsonc` 讀取設定，也可以放在使用者層的 `~/.config/opencode/opencode.json`。MCP 伺服器設定放在 `mcp` 物件底下，傳輸類型是 `local`。

## 專案設定

在專案根目錄的 `opencode.json` 加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "smilework": {
      "type": "local",
      "command": [
        "/Users/you/.bun/bin/bun",
        "/Users/you/src/SmileWork/src/cli/index.ts",
        "mcp"
      ],
      "enabled": true,
      "environment": {
        "SMILEWORK_PROFILE": "worker",
        "SMILEWORK_ACTOR": "opencode",
        "SMILEWORK_MODEL": "your-model",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    }
  }
}
```

`command` 的第一個元素要填 `bun` 的絕對路徑。OpenCode 會把 `environment` 疊在目前程序環境之上；這裡設定的值優先。`SMILEWORK_PROJECT` 指向要操作工作的 git 專案；如果 OpenCode 一定從專案根目錄啟動，可以省略。

存檔後開新工作階段，或用 `opencode mcp list` 確認 `smilework` 的狀態。工具會出現在 `smilework` 這個伺服器名稱底下。

## 使用者設定

要讓所有專案共用同一個設定，把同樣的 `mcp` 區塊放進 `~/.config/opencode/opencode.json`。如果每個專案要連到不同資料庫，優先用專案設定，並在 `environment` 裡指定不同的 `SMILEWORK_HOME`。

## 使用

先請代理呼叫 `status`，確認 profile 與專案識別碼。日常流程是 `work_list` → `work_get` → `work_update`，完成後用 `work_review` 記錄審查，再用 `work_complete` 結案。

整理代理請另建一個伺服器項目，名稱可以用 `smilework-curator`，`SMILEWORK_PROFILE` 設為 `curator`；設定範例見[整理代理](curator.md)。
