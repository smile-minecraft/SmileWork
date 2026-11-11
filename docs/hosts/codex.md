# Codex

Codex 從 `~/.codex/config.toml` 讀取 MCP 伺服器設定。stdio 伺服器放在 `mcp_servers` 資料表底下，欄位包含 `command`、`args`、`env` 與選填的 `cwd`。

## 設定

在 `~/.codex/config.toml` 加入：

```toml
[mcp_servers.smilework]
command = "/Users/you/.bun/bin/bun"
args = ["/Users/you/src/SmileWork/src/cli/index.ts", "mcp"]
cwd = "/Users/you/src/your-project"
env = { SMILEWORK_PROFILE = "worker", SMILEWORK_ACTOR = "codex", SMILEWORK_MODEL = "your-model", SMILEWORK_PROJECT = "/Users/you/src/your-project" }
```

`command` 要填絕對路徑。Codex 會把 `env` 裡的變數提供給伺服器；`cwd` 同時決定伺服器程序的起始目錄，讓沒有 `SMILEWORK_PROJECT` 時也能從 git 根目錄解析專案。兩個都設定不會衝突。

存檔後用下面的指令確認設定：

```sh
codex mcp list
```

需要機器可讀的輸出時加上 `--json`。工具會出現在 `smilework` 這個伺服器名稱底下。

## 使用

先請 Codex 呼叫 `status`，確認 profile、資料庫路徑與專案識別碼。接著用 `work_create` 建立工作、`work_update` 推進狀態、`verify_run` 留下伺服器證據。非高風險工作可以直接用 `work_complete` 結案；高風險或需要獨立審查時，先請非 owner 用 `work_review` 記錄 `approve`，再結案。

整理代理請再加一個 `[mcp_servers.smilework-curator]` 區塊，`SMILEWORK_PROFILE` 設為 `curator`；設定範例見[整理代理](curator.md)。
