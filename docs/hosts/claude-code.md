# Claude Code

Claude Code 從專案根目錄的 `.mcp.json` 讀取專案範圍的 MCP 伺服器，也可以用 `claude mcp add` 寫進使用者設定。

## 專案設定

在要使用 SmileWork 的專案根目錄建立 `.mcp.json`：

```json
{
  "mcpServers": {
    "smilework": {
      "command": "/Users/you/.bun/bin/bun",
      "args": [
        "/Users/you/src/SmileWork/src/cli/index.ts",
        "mcp"
      ],
      "env": {
        "SMILEWORK_PROFILE": "worker",
        "SMILEWORK_ACTOR": "claude-code",
        "SMILEWORK_MODEL": "claude-sonnet-4-5",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    }
  }
}
```

`command` 要填 `bun` 的絕對路徑。可以用 `which bun` 查詢；Claude Code 啟動子程序時的 `PATH` 不一定和終端機相同。`SMILEWORK_PROJECT` 要填這個專案的根目錄；如果 Claude Code 一定從專案根目錄啟動，也可以省略，讓伺服器從工作目錄解析。

第一次使用 `.mcp.json` 時，Claude Code 會要求核准這個專案範圍的伺服器。核准後用 `claude mcp list` 確認 `smilework` 已連線。

## 使用者設定

不想把設定放進專案時，用 CLI 加入使用者範圍：

```sh
claude mcp add smilework \
  -e SMILEWORK_PROFILE=worker \
  -e SMILEWORK_ACTOR=claude-code \
  -e SMILEWORK_MODEL=claude-sonnet-4-5 \
  -e SMILEWORK_PROJECT=/Users/you/src/your-project \
  -- /Users/you/.bun/bin/bun /Users/you/src/SmileWork/src/cli/index.ts mcp
```

`-e` 可以重複，`--` 後面才是伺服器指令與參數。加 `--scope user` 可以只寫進使用者設定；不加時依 Claude Code 目前的 scope 規則處理。

## 使用

連線成功後，Claude Code 會把工具掛在 `mcp__smilework__` 前綴下，例如 `mcp__smilework__work_create`、`mcp__smilework__verify_run`。先請代理呼叫 `status`，再開始建立工作。

整理代理請用另一個名稱和 `SMILEWORK_PROFILE=curator` 啟動，避免和執行代理共用同一個工具清單；設定範例見[整理代理](curator.md)。
