# SmileWork

SmileWork 是跨代理共用的本機 MCP 伺服器。它透過 stdio 連上 Claude Code、OpenCode、Codex 等宿主，讓同一個專案的工作、證據、知識與對話索引由同一份資料庫管理。資料保存在 `~/.smilework/`，伺服器本身不呼叫 LLM，也不連網。

目前版本是 0.1.0，尚未發佈到 npm。請從原始碼執行。

## 提供什麼

- 21 個 MCP 工具，分成工作、驗證、狀態、訊號、知識與對話六個領域。
- 三種工具 profile：`worker` 12 個、`curator` 15 個、`full` 21 個。
- 工作流程：建立、更新、依賴、可開始清單、審查、結案。結案會檢查驗收結果、證據、依賴與高風險核准。
- 伺服器驗證：`verify_run` 只能執行白名單 runner（`bun`、`npm`、`pytest`、`cargo`、`gradle`、`swift`），輸出寫成可追查的伺服器證據。
- 知識：寫入前檢查、版本、歷史、還原、退役與升級。
- 訊號：記錄糾正、失敗、修好、審查退回與教訓。
- 對話：索引 Claude Code、Codex 與 OpenCode 的對話紀錄，支援搜尋與讀取。
- 匯出與匯入：舊版 `.ultrawork/` 匯出成 `smilework-export` v1，再匯入本機資料庫。
- MCP resources 與 prompts：工作看板、單一工作、知識索引，以及派工、審查、整理三個提示。

## 需求

- Bun 1.3 以上
- 一個 git 專案（工作會綁定專案根目錄）

## 安裝與檢查

```sh
bun install
bun run typecheck
bun test
bun run build
```

查看 CLI 說明：

```sh
bun run src/cli/index.ts --help
```

檢查環境：

```sh
bun run src/cli/index.ts doctor --json
```

`doctor` 只讀取現有狀態。資料庫或對話索引尚未建立時，它會回報警告與下一步，不會自動寫入資料。

## 連上宿主

先設定共用環境變數：

```sh
export SMILEWORK_ACTOR=my-agent
export SMILEWORK_MODEL=my-model
export SMILEWORK_PROFILE=worker
```

`SMILEWORK_ACTOR` 與 `SMILEWORK_MODEL` 會寫進工作、證據與事件紀錄。`SMILEWORK_PROFILE` 選擇工具清單；未設定時預設 `full`。`SMILEWORK_PROJECT` 可以指定專案根目錄，省略時從程序的工作目錄往上找 git 根目錄。

### 設定範例

Claude Code 的專案 `.mcp.json`：

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
    }
  }
}
```

OpenCode 的 `opencode.json`：

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
    }
  }
}
```

Codex 的 `~/.codex/config.toml`：

```toml
[mcp_servers.smilework]
command = "/Users/you/.bun/bin/bun"
args = ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"]
cwd = "/Users/you/src/your-project"
env = { SMILEWORK_PROFILE = "worker", SMILEWORK_ACTOR = "codex", SMILEWORK_MODEL = "your-model", SMILEWORK_PROJECT = "/Users/you/src/your-project" }
```

整理代理用同一個指令，把 `SMILEWORK_PROFILE` 改成 `curator`，並換一個伺服器名稱（例如 `smilework-curator`），避免和執行代理混在一起。三家宿主的完整範例：

- [Claude Code](docs/hosts/claude-code.md)
- [OpenCode](docs/hosts/opencode.md)
- [Codex](docs/hosts/codex.md)
- [整理代理](docs/hosts/curator.md)
- [共同設定與 profile 說明](docs/hosts/README.md)

## 跑完一輪工作

連線成功後，請代理依序呼叫：

1. `work_create`：建立工作，填 `title`、`objective`、`acceptance` 與 `risk`。高風險工作要設 `risk: "high"`。
2. `work_update`：把 `status` 改成 `in_progress`。人工證據可以在這裡用 `evidence` 一起寫入。
3. `verify_run`：指定 `workId`、`runner` 與 `script`，由伺服器執行驗證並建立伺服器證據。例如 `runner: "bun"`、`script: "test"`。
4. `work_review`：由非 owner 的審查者記錄 `approve`、`concerns` 或 `reject`。高風險工作一定要有非 owner 的 `approve`。
5. `work_complete`：逐項回報驗收結果，`met: true` 的項目要附 `evidenceIds`。缺少驗收、證據、依賴或高風險核准時，結案會失敗並回報原因。

完成後用 `work_get` 讀回工作，確認狀態是 `done`、`resolution` 是 `completed`，而且證據與審查都留下紀錄。

## CLI

下表用安裝後的 `smilework`。從原始碼執行時，把 `smilework` 換成 `bun run src/cli/index.ts`。

| 指令 | 用途 |
| --- | --- |
| `smilework mcp` | 啟動 MCP stdio 伺服器。 |
| `smilework doctor [--json]` | 檢查設定、資料庫、專案、actor、技能連結與對話索引。 |
| `smilework project list` | 列出已登記的專案；`--project` 可先登記指定路徑。 |
| `smilework project relink` | 專案搬移後，用 `--id` 或 `--from` 重新對應。 |
| `smilework hooks install` | 安裝選配的 git pre-commit 檢查，擋下含已登記工作或計畫 ID 的提交。 |
| `smilework hooks uninstall` | 移除本工具建立的 pre-commit，不動別人的 hook。 |
| `smilework hooks status` | 顯示 pre-commit 狀態。 |
| `smilework hooks check` | 檢查暫存變更是否含已登記 ID。 |
| `smilework transcripts status` | 顯示對話索引狀態。 |
| `smilework transcripts index` | 建立或增量更新索引；`--rebuild` 先清空再重建。 |
| `smilework link` | 把使用者層或專案層技能連到宿主技能資料夾。 |
| `smilework export` | 從本機資料庫輸出 `smilework-export` v1。 |
| `smilework export-v3` | 把舊版 `.ultrawork/` 資料輸出成 `smilework-export` v1。 |
| `smilework import` | 把 `smilework-export` v1 匯入本機資料庫；`--dry-run` 只檢查不寫入。 |
| `smilework usage record` | 記錄一次工具或知識使用事件。 |

每個子命令都支援 `--help`。

## 資料位置

| 路徑 | 內容 |
| --- | --- |
| `~/.smilework/smilework.db` | 專案、工作、事件、證據、訊號、知識與使用量。 |
| `~/.smilework/knowledge-store/` | 知識與技能的檔案快照。 |
| `~/.smilework/evidence/` | `verify_run` 的完整輸出。 |
| `~/.smilework/transcripts.db` | 對話索引。 |
| `~/.smilework/config.jsonc` | 使用者層 profile 與停用工具設定。 |

`SMILEWORK_HOME` 可以改掉整個資料目錄。多個宿主共用同一個資料庫時，SQLite 以 WAL 模式開啟，並設定 `busy_timeout`；同時大量寫入仍可能遇到忙碌，重試即可。

## 文件

- [文件索引](docs/README.md)
- [宿主設定](docs/hosts/README.md)
- [匯出格式 v1](docs/export-format-v1.md)

## 開發

```sh
bun install
bun test
bun run typecheck
bun run build
```

- 測試使用 `bun test`，型別檢查使用 `tsc --noEmit`。
- `bun.lock` 要進版控，不要手動編輯。
- 研究筆記與 spike 放在 `.ultrawork/research/`，不進版控。

## 目前限制

- 只提供 stdio 傳輸，沒有 HTTP 常駐程式。
- 三個 profile 的工具數量固定為 12、15、21；專案層設定只能停用工具，不能改 profile。
- 尚未發佈 npm、建立 tag 或 GitHub release。
- 不做雲端同步，也不在伺服器內呼叫 LLM。
