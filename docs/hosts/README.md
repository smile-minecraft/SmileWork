# 連上宿主

SmileWork 是一個以 stdio 連線的 MCP 伺服器。宿主啟動伺服器程序後，會看到目前 profile 允許的工具、三個資源與三個提示。多個宿主可以同時連上同一個 `SMILEWORK_HOME`；資料庫以 SQLite WAL 模式開啟，並設定 `busy_timeout`，讓多個程序輪流寫入。

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
| `SMILEWORK_PROJECT` | 否 | 專案根目錄。省略時從程序的工作目錄往上找 git 根目錄；不是 git repo 時找 `.ultrawork/tasks.json`，都沒有就用目前資料夾的路徑。 |
| `SMILEWORK_ACTOR` | 建議 | 操作者名稱，會寫進工作、審查與事件紀錄。未設定時記為 `unknown`。 |
| `SMILEWORK_MODEL` | 建議 | 模型名稱，和 actor 一起記在證據與事件裡。 |
| `SMILEWORK_PI_SESSIONS_DIR` | 否 | Pi 的 session 資料夾，預設 `~/.pi/agent/sessions`。 |

工具需要可解析的專案。若宿主的工作目錄不在目標專案裡，請明確設定 `SMILEWORK_PROJECT`。非 git 資料夾也有穩定的路徑身分；有舊 `.ultrawork/tasks.json` 時會接回匯入時的 projectId。第一次在 `X` 建立工作後，之後在 `X/plugins` 這類子資料夾開啟會接回同一個專案；檔案系統根目錄與系統暫存根目錄不建立路徑專案。

## 跨代理接續

`work_create` 會記下建立時的 git HEAD，`work_get` 的 brief 會列出 `git diff <baseCommit>`，讓不是作者的代理不用猜審查範圍。

`work_update` 可以用 `evidence` 留下交接與決定：

```json
{
  "id": "work-...",
  "expectedVersion": 3,
  "evidence": [
    {
      "kind": "handoff",
      "summary": "交接待審查",
      "details": {
        "currentState": "資料層完成，工具層還沒接。",
        "decisions": ["沿用 events 儲存交接"],
        "nextSteps": ["接上 work_get", "補測試"],
        "unverified": ["舊資料庫的 migration"]
      }
    },
    {
      "kind": "ruling",
      "summary": "交接放在 events",
      "details": {
        "decision": "交接放在 events",
        "rationale": "匯出格式已經包含 events",
        "costIfWrong": "查詢要自己挑最新一筆"
      }
    }
  ]
}
```

`work_get` 預設帶出最新一份交接與所有決定；brief、`work_review` 與 `work_complete` 的回傳也看得到。知識項目可以用 `scopePaths` 標註適用路徑，brief 會自動列出相關的 decision／pitfall。

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

## 支援的宿主

- [Claude Code](claude-code.md)
- [OpenCode](opencode.md)
- [Codex](codex.md)
- [Pi](pi.md)

整理代理另外用 `SMILEWORK_PROFILE=curator` 啟動一個伺服器項目，設定方式見[整理代理](curator.md)。

## 確認連線

Claude Code 用 `claude mcp list`、OpenCode 用 `opencode mcp list`、Codex 用 `codex mcp list` 確認 MCP 伺服器；Pi 開新 session 後看工具是否出現。連線成功後，請代理呼叫一次 `status`，確認回傳的 `profile`、資料庫路徑與專案識別碼符合預期。

也可以先在終端機檢查環境：

```sh
bun /Users/you/src/SmileWork/src/cli/index.ts doctor --json
```

`doctor` 只讀取現有狀態。資料庫或對話索引尚未建立時，它會列出警告與下一步，不會自動寫入資料。
