# 變更紀錄

## 0.1.0 - 2026-11-07

第一版。

### 新增

- MCP stdio 伺服器，提供 21 個工具、3 個資源與 3 個提示。
- 三種工具 profile：`worker`（12）、`curator`（15）、`full`（21），可用環境變數或使用者層設定選擇，專案層設定只能停用工具。
- 工作流程：建立、讀取、列表、可開始清單、更新、依賴、審查與結案。支援樂觀鎖、冪等鍵與事件紀錄。
- 結案閘門：驗收結果、證據、依賴、高風險審查與伺服器證據；不符合時回傳固定錯誤碼與下一步。
- `verify_run`：以白名單 runner 執行驗證，限制 script、參數與工作目錄，輸出寫成伺服器簽發的證據。
- 知識：寫入前靜態檢查、版本、歷史、還原、退役、升級、搜尋與讀取。
- 訊號：記錄糾正、失敗、修好、審查退回、教訓與其他訊號，支援標記與處理理由。
- 對話：Claude Code、Codex 與 OpenCode 的對話紀錄索引、搜尋與讀取。
- 匯出與匯入：`smilework-export` v1 格式與 JSON Schema、從本機資料庫匯出、舊版 `.ultrawork/` 匯出、匯入與 dry-run。
- CLI：`mcp`、`project`、`doctor`、`hooks`、`transcripts`、`link`、`usage`、`export`、`export-v3`、`import`。
- SQLite migration、WAL、`busy_timeout` 與交易輔助，支援多個程序共用同一個資料庫。
- 宿主設定文件：Claude Code、OpenCode、Codex 與整理代理。

### 已知限制

- 只提供 stdio 傳輸，沒有 HTTP 常駐程式。
- 尚未發佈 npm、建立 git tag 或 GitHub release。
- 不在伺服器內呼叫 LLM，也不做雲端同步。
