# 連上宿主

SmileWork 是一個以 stdio 連線的 MCP 伺服器。宿主啟動伺服器程序後，會看到目前 profile 允許的工具、三個資源與三個提示。三個宿主可以同時連上同一個 `SMILEWORK_HOME`；資料庫以 SQLite WAL 模式開啟，並設定 `busy_timeout`，讓多個程序輪流寫入。

## 共同設定

先確認 Bun 1.3 以上已安裝，而且 `bun` 在宿主程序的 `PATH` 裡。以下範例把 SmileWork 原始碼放在 `/Users/you/src/SmileWork`，實際使用時換成自己的路徑。

只從原始碼執行時，伺服器指令是：

```sh
bun /Users/you/src/SmileWork/src/cli/index.ts mcp
```

套件已發佈到 npm，安裝後同一個入口是 `smilework mcp`。以下範例使用原始碼路徑；改用套件時，把 `bun /Users/you/src/SmileWork/src/cli/index.ts mcp` 換成 `smilework mcp`。

### 環境變數

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `SMILEWORK_HOME` | 否 | 資料目錄，預設 `~/.smilework`。測試或分開的專案群組可以指向不同位置。 |
| `SMILEWORK_PROFILE` | 否 | `worker`、`curator` 或 `full`。未設定時預設 `worker`；環境變數優先於全域設定。 |
| `SMILEWORK_PROJECT` | 否 | 專案根目錄。省略時從程序的工作目錄往上找 git 根目錄。 |
| `SMILEWORK_ACTOR` | 建議 | 操作者名稱，會寫進工作、審查與事件紀錄。未設定時記為 `unknown`。 |
| `SMILEWORK_MODEL` | 建議 | 模型名稱，和 actor 一起記在證據與事件裡。 |

工具需要可解析的專案。若宿主的工作目錄不在目標 repo 裡，請明確設定 `SMILEWORK_PROJECT`。

### 選擇 profile

| Profile | 工具數 | 用途 |
| --- | --- | --- |
| `worker` | 12 | 一般執行代理。能建立、更新、審查與結案工作，執行 `verify_run`，讀知識，記訊號。 |
| `curator` | 15 | 整理代理。能讀工作、整理知識、搜尋對話與處理訊號，不能建立或修改工作。 |
| `full` | 21 | 全部工具，適合單一代理或本機維護。 |

`worker` 不含 `transcript_search`、`transcript_read`；`curator` 不含 `work_create`、`work_update`、`work_complete`、`work_review`、`work_ready`、`verify_run`。完整的工具名稱與數量由伺服器在連線時決定，宿主不需要自己過濾。

### 兩層設定檔

使用者層設定放在 `SMILEWORK_HOME/config.jsonc`，可以選 profile，也可以停用個別工具：

```jsonc
{
  "profile": "worker",
  "disabledTools": ["knowledge_retire"]
}
```

專案層設定放在專案根目錄的 `.smilework.jsonc`，只能停用目前 profile 已有的工具，不能提高權限：

```jsonc
{
  "disabledTools": ["signal_note"]
}
```

設定檔格式錯誤時，伺服器會在 stderr 留下警告，並忽略那一層設定。專案層的 `profile` 會被忽略。

## 三個宿主

- [Claude Code](claude-code.md)
- [OpenCode](opencode.md)
- [Codex](codex.md)

整理代理另外用 `SMILEWORK_PROFILE=curator` 啟動一個伺服器項目，設定方式見[整理代理](curator.md)。

## 確認連線

每個宿主都提供列出 MCP 伺服器的指令：Claude Code 用 `claude mcp list`，OpenCode 用 `opencode mcp list`，Codex 用 `codex mcp list`。連線成功後，請代理呼叫一次 `status`，確認回傳的 `profile`、資料庫路徑與專案識別碼符合預期。

也可以先在終端機檢查環境：

```sh
bun /Users/you/src/SmileWork/src/cli/index.ts doctor --json
```

`doctor` 只讀取現有狀態。資料庫或對話索引尚未建立時，它會列出警告與下一步，不會自動寫入資料。
