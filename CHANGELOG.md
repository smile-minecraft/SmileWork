# 變更紀錄

## 0.2.1 - 2026-11-11

這個版本讓非高風險工作可以直接結案，並改善驗收比對與 Swift 驗證的診斷。

### 修正

- 驗收結果的比對改用 NFKC、收合連續空白並去掉前後空白，資料庫與回傳仍保留工作定義的原始字串。真的不一致時，`ACCEPTANCE_INCOMPLETE` 的 `data.suggestions` 提供 `missing`、`reported` 與 `distance`，訊息最多列出 3 條缺少，其餘以「另有 N 條缺少」表示。
- `verify_run` 在 macOS 上使用實際的 Swift 工具鏈：PATH 的 `swift` 若是 `/usr/bin/swift` 系統 stub，會以 `/usr/bin/xcrun --find swift` 依 `DEVELOPER_DIR` 或 `xcode-select` 的設定解析；xcrun 失敗時退回 PATH 的 `swift`。Swift 失敗且輸出出現 `Invalid manifest`，或同時出現 `Undefined symbols` 與 `PackageDescription` 時，結果附上 `hint`，並寫進 evidence details、輸出檔與 summary。單獨出現 `PackageDescription` 或 `Undefined symbols` 不會誤報。
- 結案寫入的 `acceptanceResults.items[].criterion` 保留工作定義的原始字串（包含前後空白），修正匯入後的工作在匯出時出現 `DATABASE_ACCEPTANCE_MISMATCH` 的回歸。

### 變更

- `work_complete` 允許非高風險工作從 `in_progress` 直接結案，條件是驗收、證據與依賴都通過。高風險工作仍須在 `review` 狀態、由非 owner 的審查者 `approve`，並至少有一筆成功且未逾時的伺服器證據。`open` 與 `blocked` 仍須先轉到 `in_progress`。目前版本記錄的 `reject` 會擋下非高風險的直接結案；工作改版後，那筆 `reject` 視為舊版本。
- `work_update` 回傳新增的 `addedEvidence`，只包含本次新增的一般證據（`handoff` 與 `ruling` 不算），沒有新增時是空陣列。`data.evidence` 仍保留完整清單。

### 已知限制

- `worker` 的 `tools/list` 是 2993／3000 token（o200k），只剩 7 token；後續新增工具描述前要先量測。
- `work_update` 目前可以把 `risk` 從 `high` 改成 `low` 再直接結案。這是既有行為，沒有在 0.2.1 修正，後續要處理。
- `verify_run` 的 Swift 提示只說明工具鏈的選擇；實際能不能執行 SwiftPM 仍取決於機器上的 Xcode 或 Command Line Tools。

## 0.2.0 - 2026-11-09

這個版本讓多個代理在同一份工作與知識上接得下去，也修掉實際使用時卡住的專案解析、migration 與匯出問題。未單獨發佈，內容包含在 0.2.1。

### 新增

- 非 git 資料夾的專案身分：以正規化絕對路徑雜湊出 `projectId`；有舊 `.ultrawork/tasks.json` 時優先接回匯入時的 projectId。`Test-Server-Folia` 等資料夾可以直接使用工作類工具。
- 工作建立時記錄 `baseCommit`（git HEAD）。`work_get` 的 brief 與審查提示會列出可直接執行的 `git diff <baseCommit>`；非 git 專案為 null。
- 跨代理交接：`work_update` 的 `evidence` 新增 `kind: handoff`，用 `details` 記錄目前狀態、做過的決定、下一步與還沒驗證的事。`work_get` 預設帶出最新一份，brief、審查與結案回傳都看得到。
- 決定紀錄：`work_update` 的 `evidence` 新增 `kind: ruling`，記錄決定、理由與錯了會怎樣。審查與結案回傳會帶上所有 rulings。
- 知識的 `scopePaths`：`knowledge_write` 可以標註專案內相對路徑 glob。`work_get` 產生 brief 時，會把與工作 `scopePaths` 對得上的 decision／pitfall 列在「相關知識」，附 ID 與一句摘要。
- Pi 宿主支援：`smilework link` 會連結 `~/.pi/agent/skills` 與 `<repo>/.pi/skills`，`doctor` 會檢查 Pi 技能連結；對話索引支援 `~/.pi/agent/sessions/--<slug>--/*.jsonl`。
- migration 內容雜湊：`schema_migrations` 記錄每個 migration 的 sha256。已套用的檔案被修改、改名或刪除時，啟動會以 `MIGRATION_HASH_MISMATCH`、`MIGRATION_RENAMED` 或 `MIGRATION_FILE_MISSING` 停止。

### 修正

- `export-v3` 在 `--project` 與 `--global` 指向同一個 `.ultrawork` 時，只讀一次並以 project 層匯出，不再產生重複的知識、訊號與 raw 檔。
- `import` 在套用階段失敗時，CLI 回非零結束碼；補上回歸測試。
- 非 git 的路徑專案會接回已登記的上層資料夾，先在 `X` 建工作、之後從 `X/plugins` 開啟時不會變成另一個專案。`/` 與系統暫存根目錄不建立路徑專案。
- `work_update` 的 `output` 證據缺少 `path` 時，下一步會說明改用 `kind: note` 或 `verify_run`。
- `work_complete` 在非 `review` 狀態被呼叫時，下一步會給出實際的 `work_review` 與 `work_complete` 版本號指令。
- 資料庫 JSON 欄位損壞、冪等鍵快取回放內容不完整時，回 `INTERNAL_ERROR` 並附實體與欄位，不再假裝成功或回空值。
- 高風險結案要求至少一筆成功且未逾時的伺服器證據；失敗或 details 損壞的證據不再能讓工作通關。

### 變更

- `doctor` 與 `status` 顯示設定檔解析後的 profile，並接受 `config.jsonc`、`.smilework.jsonc` 的設定。
- `disabledTools` 包含未知工具名稱時會留下警告，不再默默忽略。
- `smilework link` 預設處理 Claude Code；偵測到 `~/.pi` 或專案 `.pi` 時一併處理 Pi。新增 `--host all|claude|pi`。

### 已知限制

- `smilework-export` v1 尚未包含知識的 `scopePaths`，匯出再匯入後會是空陣列。
- `baseCommit` 存在 `work_items` 與建立事件中，但匯出格式的 work 記錄沒有獨立欄位。
- Pi 的 session 資料夾 slug 在路徑含連字號時無法無損還原；索引優先使用 session 紀錄裡的 `cwd`，slug 只在缺少 `cwd` 時當備援。
- `work_update` 的 `handoff`／`ruling` 內容放在 `details`，格式由工具描述與執行時的驗證約定，不是獨立的巢狀 schema（為了讓 worker 的 tools/list 維持在 3000 token 以內）。

## 0.1.1 - 2026-11-07

發佈流程改由 GitHub Actions 執行。這個版本沒有功能變更。

### 修正

- npm 頁面的 README 更新為目前的安裝說明與預設 `worker` profile。

### 變更

- 新增 tag 觸發的發佈 workflow，以 npm Trusted Publishing（OIDC）發佈並產生 provenance。
- `package.json` 加入 `publishConfig.access: public`。

## 0.1.0 - 2026-11-07

第一版。已發佈到 npm（`smilework@0.1.0`）與 GitHub Release（`v0.1.0`）。

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
- 不在伺服器內呼叫 LLM，也不做雲端同步。
