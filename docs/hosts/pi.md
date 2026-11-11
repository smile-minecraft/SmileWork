# Pi

Pi 從 `~/.pi/agent/mcp.json` 讀取使用者層的 MCP 伺服器，專案層則是專案根目錄的 `.pi/mcp.json`。格式和 Claude Code 的 `.mcp.json` 一樣，最外層是 `mcpServers`。

## 設定

使用者層的 `~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "smilework": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"],
      "env": {
        "SMILEWORK_PROFILE": "worker",
        "SMILEWORK_ACTOR": "pi",
        "SMILEWORK_MODEL": "your-model",
        "SMILEWORK_PROJECT": "/Users/you/src/your-project"
      }
    }
  }
}
```

專案層的 `.pi/mcp.json` 放同樣的 `mcpServers` 區塊。`command` 要填 `bun` 的絕對路徑；`env` 會疊在 Pi 目前的程序環境上。工具會出現在 `smilework` 這個伺服器名稱底下。

整理代理用另一個伺服器名稱，例如 `smilework-curator`，並把 `SMILEWORK_PROFILE` 設成 `curator`；範例見[整理代理](curator.md)。

## 技能

Pi 的技能資料夾是：

- 使用者層：`~/.pi/agent/skills/`
- 專案層：`<repo>/.pi/skills/`

`smilework link` 預設會處理 Claude Code；如果偵測到 `~/.pi` 或專案裡的 `.pi`，也會一併建立 Pi 技能連結。要只處理 Pi，執行：

```sh
smilework link --host pi
smilework link --host pi --project /Users/you/src/your-project
```

`smilework link` 只建立或確認 symlink，不會覆寫同名的實體資料夾，也不會自動刪除孤兒連結。`smilework doctor` 在 `~/.pi` 存在時會一起檢查 Pi 技能連結的缺失、斷鏈與衝突。

## 對話索引

Pi 的 session 放在 `~/.pi/agent/sessions/`，每個專案一個資料夾，資料夾名稱是 `--<slug>--`。slug 的規則是工作目錄去掉開頭的 `/`，再把每個 `/` 換成 `-`。例如 `/Users/smile` 對應 `--Users-smile--`。

每個 session 是 `*.jsonl`，主要紀錄型別是 `session`、`message` 與 `model_change`。`message.role` 有 `user`、`assistant` 與 `toolResult`；assistant 的內容區塊包含 `text`、`thinking` 與 `toolCall`。

`smilework transcripts index` 會預設讀取 `~/.pi/agent/sessions`，搜尋結果的來源名稱是 `pi`。要換位置時設定：

```sh
export SMILEWORK_PI_SESSIONS_DIR=/path/to/pi/sessions
```

Pi 的 session 紀錄帶有 `cwd`，索引會優先採用它；只有在紀錄缺少 `cwd` 時，才從 slug 還原路徑。路徑本身含連字號時還原可能不準，這種情況請以 `cwd` 為準。

## 確認連線

先請 Pi 呼叫一次 `status`，確認 `profile`、資料庫路徑與專案識別碼。接著用 `work_list` 找可做的事，`work_get` 讀取工作，`work_update` 推進狀態，再用 `work_complete` 結案；高風險或需要獨立審查時，先請非 owner 用 `work_review` 記錄 `approve`。
