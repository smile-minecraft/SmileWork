# SmileWork 匯出格式 v1

`smilework-export` 是 SmileWork 的可攜資料格式。v1 用來把舊版 `.ultrawork/` 資料完整搬進新資料庫，也作為新資料庫匯出與外部工具交換資料的共同格式。這份文件是 v1 的公開規格；JSON Schema 在 [`schemas/export-v1/export-v1.schema.json`](../schemas/export-v1/export-v1.schema.json)。

這個格式只描述檔案與資料，不規定匯出器怎麼讀取舊資料、也不規定匯入器怎麼建立資料庫資料列。讀取器必須先檢查版本與結構，再處理內容。

## 這個格式要解決的問題

- 舊資料可以離開舊宿主，不需要舊程式繼續執行。
- 匯出、傳遞、匯入的過程中，來源資料不會被修改。
- 同一份來源重跑匯出，內容檔案會產生相同的位元組，方便比對與除錯。
- 匯入器與新資料庫 schema 有共同的欄位、型別與狀態定義。

這個格式不做的事：

- 不在檔案裡執行任何程式，也不包含可執行的外掛或指令。
- 不把資料壓縮、加密或打包成單一壓縮檔。v1 是一個資料夾。
- 不保證跨版本相容。版本規則見〈formatVersion 的升級規則〉。
- 不保存資料庫的內部資料列編號、索引或查詢結果。那些由匯入器重建。

## 三個原則

### 無損

匯出包必須保留來源的全部資訊。做法有兩層：

1. 能對應到格式欄位的資料，寫進 `work.jsonl`、`events.jsonl`、`evidence.jsonl`、`signals.jsonl` 與 `knowledge/`。
2. 無法對應的資料，以及所有需要逐位元組證明的來源檔案，依來源層原樣放進 `raw/project/` 或 `raw/global/`。`mapping.jsonl` 記錄舊識別碼、新識別碼與來源位置。

`manifest.layout` 的計數必須和實際內容一致。匯出器遇到無法對應的狀態、欄位或檔案時，不能丟掉，也不能猜測；要放進對應的 raw 層，並在 `manifest.warnings` 留下一行說明。讀取器看到 warning 仍然可以匯入，但要讓使用者知道哪些資料沒有進入正規化欄位。

`raw/` 的每個檔案都必須有一筆 `entity: "raw"` 的 mapping，內含檔案的 SHA-256。這是「來源沒有被改寫」與「raw 沒有被替換」的依據。

### 唯讀

- 匯出器只讀來源目錄，不改名、不刪除、不寫入來源。
- 匯出完成後，匯出包是唯讀資料。讀取器與匯入器不得修改包內的檔案，也不得在包內建立暫存檔。
- `raw/` 永遠是來源的位元組副本。任何人都不會在 `raw/` 裡重新格式化 JSON、轉換編碼或整理換行。
- 匯出到已存在的非空資料夾時，工具必須拒絕，除非使用者明確要求取代；取代時也要先完成新包再替換，不能邊寫邊覆蓋舊包。

### 可重跑

同一份來源、同樣的匯出選項、同一個 producer 版本，重跑兩次產生的內容檔案必須逐位元組相同。唯一允許不同的是 `manifest.createdAt`。

為了做到這件事，v1 規定：

- 內容檔案使用 UTF-8、LF 換行，不寫 BOM。
- JSON 物件的鍵依照 Unicode 碼點排序。JSONL 每行是緊湊 JSON，不加多餘空白。
- 記錄有固定排序：`work` 依 `workId`，`events` 依 `sequence`，`evidence` 依 `evidenceId`，`signals` 依 `signalId`，`knowledge` 依 `knowledgeId`，`mapping` 依 `entity`、`layer`、`sourceId`、`targetId`。
- 識別碼陣列（`work.dependsOn`、`knowledge.tags`）依碼點排序。
- 由匯出器產生的內容不含時間戳、亂數、主機名稱、絕對路徑或執行時間。
- `manifest.createdAt` 是唯一的產生時間。

「可重跑」不表示來源變更、producer 版本變更或格式版本變更之後，輸出還會一樣。那些情況本來就會產生不同的包，應該視為新的匯出。

## 套件結構

匯出包是一個資料夾。頂層只能有下列八個項目，不能多也不能少：

```text
<export>/
├── manifest.json
├── work.jsonl
├── events.jsonl
├── evidence.jsonl
├── signals.jsonl
├── knowledge/
│   ├── index.jsonl
│   └── files/
│       └── <knowledgeId>/
│           ├── v1.md
│           └── v2.md
├── mapping.jsonl
└── raw/
    ├── project/
    │   └── <專案來源的相對路徑>
    └── global/
        └── <全域來源的相對路徑>
```

| 部分 | 路徑 | 必填 | 內容 |
| --- | --- | --- | --- |
| manifest | `manifest.json` | 是 | 格式版本、產生資訊、來源身分、各部分計數與警告 |
| work | `work.jsonl` | 是 | 工作項目，包含任務與計畫 |
| events | `events.jsonl` | 是 | 狀態轉換、審查、驗證與其他事件 |
| evidence | `evidence.jsonl` | 是 | 連到工作的證據 |
| signals | `signals.jsonl` | 是 | 健康狀態、風險與警告訊號 |
| knowledge | `knowledge/` | 是 | 知識索引與版本內容 |
| mapping | `mapping.jsonl` | 是 | 舊識別碼、新識別碼與來源位置 |
| raw | `raw/` | 是 | 來源檔案的逐位元組副本；固定分成 `project/` 與 `global/` 兩層 |

五個 JSONL 檔與 `knowledge/index.jsonl` 可以是空檔案。空檔案代表 0 筆記錄，大小必須是 0 位元組；有記錄的檔案，最後一行必須有換行。

`knowledge/` 只能有 `index.jsonl` 與 `files/`。`knowledge/files/` 只能有以 `knowledgeId` 命名的資料夾；每個資料夾只能有 `v<版本>.md`。

`raw/` 只能有 `project/` 與 `global/` 兩個資料夾，兩個都要存在，沒有內容時可以是空資料夾。專案來源的檔案放 `raw/project/`，`--global` 來源的檔案放 `raw/global/`。兩層各自保留來源的相對目錄結構；同一個相對路徑出現在兩層時，它們是兩個不同的檔案，不會互相覆蓋。`raw/` 的檔案路徑必須是相對路徑，不能是絕對路徑，也不能包含 `..` 區段。

### JSONL 的寫法

- 一行一個 JSON 物件，不可是陣列、字串或數字。
- 不寫空行。
- 每行以 LF 結尾；檔案最後一行也要有 LF。
- JSON 使用 UTF-8，不寫 BOM。
- 鍵依照 Unicode 碼點排序，使用緊湊 JSON：不加縮排、冒號後不加空白、逗號後不加空白。例如 `{"a":1,"b":2}`，不是 `{ "a": 1, "b": 2 }`。
- 記錄順序固定：`work` 依 `workId`，`events` 依 `sequence`，`evidence` 依 `evidenceId`，`signals` 依 `signalId`，`knowledge` 依 `knowledgeId`，`mapping` 依 `entity`、`layer`、`sourceId`、`targetId`。相同內容重跑時，位元組必須相同。
- `work.dependsOn`、`work.nonGoals`、`work.contextRefs`、`work.scopePaths`、`knowledge.tags` 是集合，寫入前要排序。`work.acceptance` 與 `work.acceptanceResults.items` 保留原順序，因為驗收條件的順序有意義。
- 驗證器會逐行比對 canonical 形式。鍵沒有排序、加上空白、使用縮排或記錄順序錯誤時，會回報 `JSONL_NOT_CANONICAL`。

### 識別碼

`workId`、`eventId`、`evidenceId`、`signalId` 是 1 到 256 字元的字串，內容不限定 ASCII。`knowledgeId` 會變成資料夾名稱，因此只允許 `[A-Za-z0-9][A-Za-z0-9._-]*`，長度 1 到 128。舊識別碼不符合這個規則時，匯出器要產生安全的新識別碼，並用 `mapping.jsonl` 記下舊值。

識別碼在各自的部分內必須唯一。`event.sequence` 也要唯一。

### 時間戳

由匯出器產生的內容檔案不能有時間戳欄位。像是 `createdAt`、`updatedAt`、`generatedAt`、`exportedAt`、`modifiedAt`、`created_at`、`updated_at`、`generated_at`、`exported_at`、`verified_at`、`verifiedAt`、`timestamp`、`exportTime` 這些鍵，都不允許出現在 `work.jsonl`、`events.jsonl`、`evidence.jsonl`、`signals.jsonl`、`knowledge/index.jsonl` 與 `mapping.jsonl`；檢查不分大小寫。

唯一的產生時間是 `manifest.createdAt`。它只表示這個包什麼時候產生，不代表任何一筆資料的時間。

來源資料原本的時間（例如舊任務的 `updatedAt` 或記憶 frontmatter 的 `created`）屬來源內容，不寫進正規化紀錄；它們留在 `raw/` 的原始檔案裡。`mapping.jsonl` 會指出對應的來源位置。這樣做的代價是正規化紀錄不帶時間，好處是內容檔案可以逐位元組重現，而且不會把匯出時間混進資料。

`raw/` 是唯一的例外。它是來源的位元組副本，來源有什麼時間、什麼編碼、什麼換行，就原樣保留。讀取器不能把 `raw/` 當成標準 JSON 來解析。

## manifest.json

`manifest.json` 是套件的入口。讀取器必須先讀它，確認 `format` 與 `formatVersion`，再讀其他檔案。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `format` | string | 是 | 固定是 `smilework-export` |
| `formatVersion` | integer | 是 | v1 固定是 `1`，不是字串 |
| `createdAt` | string | 是 | 產生時間，UTC ISO 8601，含毫秒，例如 `2026-01-01T00:00:00.000Z` |
| `producer` | object | 是 | 產生這個包的工具 |
| `source` | object | 是 | 來源種類與專案身分 |
| `layout` | object | 是 | 八個部分的固定路徑與計數 |
| `warnings` | string[] | 是 | 無法正規化的來源資料說明；沒有就寫空陣列 |

`producer` 的欄位：

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 固定是 `smilework` |
| `version` | string | 是 | producer 的版本，格式為 `major.minor.patch`，可帶 prerelease 或 build 標記 |

`source` 的欄位：

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `kind` | string | 是 | `ultrawork-v3` 或 `smilework-db` |
| `projectId` | string | 是 | 專案識別碼 |
| `projectPath` | string | 否 | 專案路徑。匯出器預設不寫；只有使用者明確要求時才保留。下面的範例是保留的情況 |
| `registryVersion` | string | 否 | 來源 registry 的版本，例如舊資料的 `4.0` |
| `layers` | string[] | 是 | 這個包包含的來源層，至少一個；值是 `project` 或 `global`。有 `--global` 來源時要包含 `global` |

`layout` 的八個鍵固定如下。`path` 是常數：

| 鍵 | 型別 | 必填 | 內容 |
| --- | --- | --- | --- |
| `manifest` | object | 是 | `path` 固定是 `manifest.json` |
| `work` | object | 是 | `path` 固定是 `work.jsonl`；`records` 是記錄數 |
| `events` | object | 是 | `path` 固定是 `events.jsonl`；`records` 是記錄數 |
| `evidence` | object | 是 | `path` 固定是 `evidence.jsonl`；`records` 是記錄數 |
| `signals` | object | 是 | `path` 固定是 `signals.jsonl`；`records` 是記錄數 |
| `knowledge` | object | 是 | `path` 固定是 `knowledge/`；`entries` 是知識項目數；`files` 是版本檔數 |
| `mapping` | object | 是 | `path` 固定是 `mapping.jsonl`；`records` 是記錄數 |
| `raw` | object | 是 | `path` 固定是 `raw/`；`files` 是全部檔案數；`projectFiles` 與 `globalFiles` 是各層檔案數 |

`records`、`entries`、`files` 都是非負整數。範例：

```json
{
  "manifest": { "path": "manifest.json" },
  "work": { "path": "work.jsonl", "records": 5 },
  "events": { "path": "events.jsonl", "records": 7 },
  "evidence": { "path": "evidence.jsonl", "records": 3 },
  "signals": { "path": "signals.jsonl", "records": 1 },
  "knowledge": { "path": "knowledge/", "entries": 4, "files": 5 },
  "mapping": { "path": "mapping.jsonl", "records": 16 },
  "raw": { "path": "raw/", "files": 7, "projectFiles": 5, "globalFiles": 2 }
}
```

`knowledge.files` 是所有知識版本檔案的總數，不是知識項目數。`raw.files` 是 `raw/` 底下所有檔案的總數；`projectFiles` 加 `globalFiles` 必須等於 `files`。

完整的 manifest 範例：

```json
{
  "format": "smilework-export",
  "formatVersion": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "producer": {
    "name": "smilework",
    "version": "0.1.0"
  },
  "source": {
    "kind": "ultrawork-v3",
    "projectId": "fixture-project",
    "projectPath": "/fixture-placeholder/project",
    "registryVersion": "4.0",
    "layers": ["project", "global"]
  },
  "layout": {
    "manifest": { "path": "manifest.json" },
    "work": { "path": "work.jsonl", "records": 5 },
    "events": { "path": "events.jsonl", "records": 7 },
    "evidence": { "path": "evidence.jsonl", "records": 3 },
    "signals": { "path": "signals.jsonl", "records": 1 },
    "knowledge": { "path": "knowledge/", "entries": 4, "files": 5 },
    "mapping": { "path": "mapping.jsonl", "records": 16 },
    "raw": { "path": "raw/", "files": 7, "projectFiles": 5, "globalFiles": 2 }
  },
  "warnings": ["LEGACY_TITLE_FALLBACK: w-task-legacy-title"]
}
```

## work.jsonl

`work.jsonl` 放工作項目。任務與計畫都用同一種紀錄，靠 `kind` 區分。一筆工作一個 JSON 物件。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `workId` | string | 是 | 工作識別碼，套件內唯一 |
| `kind` | string | 是 | `task` 或 `plan` |
| `title` | string | 是 | 工作標題 |
| `status` | string | 是 | 狀態，只能是下表的六個值 |
| `resolution` | string | 條件式 | 終態的結果，見下方規則 |
| `owner` | string | 是 | 負責人；來源沒有時寫 `unknown` |
| `priority` | string | 是 | 優先順序，1 到 32 字元；來源沒有時寫 `medium` |
| `planId` | string | 否 | 所屬計畫的 `workId` |
| `dependsOn` | string[] | 否 | 依賴的 `workId`，不重複，排序後寫入 |
| `objective` | string | 否 | 這個工作要達成的目標 |
| `nonGoals` | string[] | 否 | 明確不做的事，不重複，排序後寫入 |
| `contextRefs` | string[] | 否 | 相關的知識、工作或套件內檔案參照，不重複，排序後寫入 |
| `scopePaths` | string[] | 否 | 允許修改的專案相對路徑，不重複，排序後寫入 |
| `acceptance` | string[] | 否 | 驗收條件，保留原順序，不重複 |
| `risk` | string | 否 | `low`、`medium` 或 `high`；沒有申報時省略 |
| `review` | object | 否 | 最近一次獨立審查的結果 |
| `acceptanceResults` | object | 否 | 結案時記錄的逐項驗收結果 |

`status` 的值：

| 值 | 意義 |
| --- | --- |
| `open` | 已建立、尚未開始 |
| `in_progress` | 進行中 |
| `blocked` | 被阻擋，等待外部條件 |
| `review` | 等待審查或結案處理 |
| `done` | 已完成或已失敗的終態 |
| `cancelled` | 已取消的終態 |

`resolution` 的規則：

- `status` 是 `done` 時，`resolution` 必填，值是 `completed` 或 `failed`。
- `status` 是 `cancelled` 時，`resolution` 必填，值是 `abandoned`。
- 其他狀態不能有 `resolution`。

選填欄位的規則：

- 沒有資料就省略欄位。不要用空陣列或空物件表示「沒有」；有這個欄位時，`nonGoals`、`contextRefs`、`scopePaths`、`acceptance` 至少要有 1 項。匯入器看到欄位不存在時，要保留為「未記錄」，不要自行補值。
- `contextRefs` 可以是 `knowledge:<knowledgeId>`、`work:<workId>` 這類識別參照，也可以是套件內安全相對路徑（`raw/project/...`、`raw/global/...`、`knowledge/...`）。不能是絕對路徑，也不能包含 `..`。
- `scopePaths` 是專案相對路徑，不是套件內路徑。不能是絕對路徑，也不能包含 `..`。
- `nonGoals`、`contextRefs`、`scopePaths` 是集合，寫入前排序。`acceptance` 的順序是驗收流程的順序，寫入時保留。
- `risk` 只接受 `low`、`medium`、`high`。v3 目前只會申報 `high`；`low` 與 `medium` 保留給未來使用。沒有申報時不要寫 `risk`。
- `review` 的欄位是 `verdict`（`approve`、`concerns` 或 `reject`）、`reviewer`，以及可選的 `note` 與 `reworkedAfterReview`。審查時間屬於來源資料，留在 `raw/`，不寫進 `work.jsonl`。
- `acceptanceResults` 的欄位是 `recordedBy` 與 `items`。`items` 至少 1 項，每項有 `criterion`、`met`，以及可選的 `evidence`。有 `acceptanceResults` 時一定要有 `acceptance`，而且 `items` 的 `criterion` 要與 `acceptance` 逐項、同順序對齊。沒有結案紀錄時省略這個欄位。

匯出器把舊狀態轉成這六個值時，要留下可追蹤的對應。建議的對照如下；遇到表上沒有的狀態，不要猜，放進 `raw/` 並在 `manifest.warnings` 說明：

| 來源狀態 | v1 狀態 | resolution |
| --- | --- | --- |
| `NEW`、`CLARIFYING`、`DRAFT`、`PLANNED` | `open` | 不寫 |
| `IN_PROGRESS`、`ACTIVE` | `in_progress` | 不寫 |
| `BLOCKED` | `blocked` | 不寫 |
| `REVIEWING`、`ARCHIVING` | `review` | 不寫 |
| `COMPLETED`、`DONE` | `done` | `completed` |
| `FAILED` | `done` | `failed` |
| `CANCELLED` | `cancelled` | `abandoned` |

### 舊資料缺少 title 時

`title` 在 schema 是必填。來源工作缺少 `title` 或 `title` 是空字串時，匯出器要：

1. 把 `title` 設成 `workId`。
2. 在 `manifest.warnings` 加入 `LEGACY_TITLE_FALLBACK: <workId>`。
3. 保留 `mapping.jsonl` 的 `sourceId` 與 `sourceRecord`，讓讀取器仍能回到來源那一筆資料。

不要在 `title` 寫空字串、`untitled` 或省略欄位。讀取器不需要再實作 fallback；它看到的 `title` 一定非空，warning 則說明這是舊資料的替代值。

範例：

```json
{"dependsOn":["w-task-format"],"kind":"task","owner":"build","planId":"w-plan-main","priority":"medium","status":"in_progress","title":"實作匯入器","workId":"w-task-import"}
```

含規劃與驗收欄位的範例：

```json
{"acceptance":["schema 可驗證範例包","文件定義八個部分"],"contextRefs":["knowledge:k-export-format","raw/project/tasks.json"],"kind":"task","objective":"定義 manifest、內容檔與 schema。","owner":"build","planId":"w-plan-main","priority":"high","resolution":"completed","review":{"note":"需要補分層與 canonical 檢查","reviewer":"momus","verdict":"concerns"},"risk":"high","scopePaths":["docs/export-format-v1.md","schemas/export-v1"],"status":"done","title":"定義匯出包格式","workId":"w-task-format"}
```

範例是排序後的緊湊 JSON；實際檔案每行都要長這樣，不能換行或加縮排。

## events.jsonl

`events.jsonl` 記錄工作發生過的事。事件沒有時間欄位；順序由 `sequence` 決定，來源的時間留在 `raw/`。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `eventId` | string | 是 | 事件識別碼，套件內唯一 |
| `sequence` | integer | 是 | 從 1 開始的順序，套件內唯一 |
| `kind` | string | 是 | 事件種類，見下表 |
| `actor` | string | 是 | 執行動作者；未知時寫 `unknown` |
| `workId` | string | 否 | 相關工作；專案層級事件可以省略 |
| `fromStatus` | string | 否 | 狀態轉換前的狀態 |
| `toStatus` | string | 否 | 狀態轉換後的狀態；`status_changed` 必填 |
| `resolution` | string | 否 | 狀態轉換的結果 |
| `summary` | string | 否 | 一行摘要 |
| `details` | object | 否 | 其他結構化資料，內容由 producer 決定 |

事件種類：

| `kind` | 用途 |
| --- | --- |
| `created` | 建立工作或計畫 |
| `status_changed` | 狀態轉換 |
| `reviewed` | 記錄審查結論 |
| `verified` | 記錄驗證結果 |
| `evidence_added` | 新增證據 |
| `signal_recorded` | 新增訊號 |
| `knowledge_written` | 寫入知識 |
| `note` | 其他需要保留的歷程 |

`details` 是唯一允許自由形狀的物件。其他欄位出現未知鍵會被 schema 拒絕；需要放額外資料時，放進 `details`，不要新增頂層欄位。

範例：

```json
{"actor":"arch","eventId":"e-003","fromStatus":"in_progress","kind":"status_changed","resolution":"completed","sequence":3,"toStatus":"done","workId":"w-plan-main"}
```

## evidence.jsonl

`evidence.jsonl` 放連到工作的證據。一筆證據一個物件。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `evidenceId` | string | 是 | 證據識別碼，套件內唯一 |
| `workId` | string | 是 | 所屬工作 |
| `kind` | string | 是 | `command`、`test`、`review`、`link`、`note` 或 `artifact` |
| `actor` | string | 是 | 產生證據的代理或人 |
| `summary` | string | 是 | 證據摘要 |
| `command` | string | 條件式 | `command` 與 `test` 必填 |
| `output` | string | 否 | 指令或測試的輸出 |
| `url` | string | 條件式 | `link` 必填，只接受 `http://` 或 `https://` |
| `path` | string | 條件式 | `artifact` 必填，必須是套件內的 `raw/project/...`、`raw/global/...` 或 `knowledge/...` 相對路徑，而且檔案要存在 |
| `sha256` | string | 否 | 指向檔案的 SHA-256，64 個小寫十六進位字元 |
| `details` | object | 否 | 其他結構化資料 |

`path` 不能是絕對路徑，也不能包含 `..`。指向套件外的檔案沒有意義，讀取器也不會跟隨。套件驗證器會確認路徑存在；`sha256` 有填時，匯入器要再比對內容。

範例：

```json
{"actor":"build","command":"bun test tests/export-format","evidenceId":"e-tests-format","kind":"test","output":"測試全數通過","summary":"匯出格式測試通過","workId":"w-task-format"}
```

## signals.jsonl

`signals.jsonl` 放健康狀態、風險與警告。訊號不是工作狀態，也不改變工作狀態。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `signalId` | string | 是 | 訊號識別碼，套件內唯一 |
| `severity` | string | 是 | `info`、`warning` 或 `error` |
| `code` | string | 是 | 大寫的代碼，例如 `UNMAPPED_STATUS`，最多 64 字元 |
| `message` | string | 是 | 給人看的說明 |
| `workId` | string | 否 | 相關工作 |
| `details` | object | 否 | 其他結構化資料 |

範例：

```json
{"code":"UNMAPPED_STATUS","message":"有一個舊狀態無法對應，已保留在 raw/","severity":"warning","signalId":"s-format-warning","workId":"w-task-import"}
```

## knowledge/

知識分成索引與內容檔。索引是 `knowledge/index.jsonl`，一行一個知識項目；內容檔是 `knowledge/files/<knowledgeId>/v<version>.md`。

### knowledge/index.jsonl

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `knowledgeId` | string | 是 | 安全的路徑識別碼，套件內唯一 |
| `type` | string | 是 | `decision`、`reference`、`lesson`、`pitfall`、`preference` 或 `document` |
| `layer` | string | 是 | `project` 或 `global` |
| `title` | string | 是 | 標題 |
| `description` | string | 是 | 說明，可以是空字串 |
| `pinned` | boolean | 是 | 是否置頂 |
| `source` | string | 是 | 來源標記，例如 `manual` |
| `versions` | object[] | 是 | 至少一筆版本 |
| `currentVersion` | integer | 是 | 目前版本，必須存在於 `versions` |
| `workId` | string | 否 | 相關工作 |
| `tags` | string[] | 否 | 標籤，不重複，排序後寫入 |

`versions` 的每一筆：

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `version` | integer | 是 | 從 1 開始的版本號 |
| `path` | string | 是 | 固定是 `knowledge/files/<knowledgeId>/v<version>.md` |
| `sha256` | string | 是 | 內容檔的 SHA-256，64 個小寫十六進位字元 |
| `bytes` | integer | 是 | 內容檔的位元組數 |

版本檔的內容是 Markdown，UTF-8，不含產生的 frontmatter，也不含時間戳。舊記憶主題的 frontmatter 原樣留在 `raw/`；`index.jsonl` 只放正規化後的欄位。

版本是不可變的。要修正內容時，新增下一個版本並把 `currentVersion` 指到它，不要改寫舊版本檔案。讀取器可以用 `sha256` 與 `bytes` 驗證內容沒有被替換。

範例索引：

```json
{"currentVersion":2,"description":"格式版本只接受整數，破壞性變更才升版。","knowledgeId":"k-export-format","layer":"project","pinned":true,"source":"manual","tags":["export","format"],"title":"匯出格式版本升級原則","type":"decision","versions":[{"bytes":38,"path":"knowledge/files/k-export-format/v1.md","sha256":"<64 個小寫十六進位字元>","version":1},{"bytes":103,"path":"knowledge/files/k-export-format/v2.md","sha256":"<64 個小寫十六進位字元>","version":2}],"workId":"w-task-format"}
```

範例內容檔 `knowledge/files/k-export-format/v1.md`：

```markdown
## 決定

格式版本只接受整數。
```

## mapping.jsonl

`mapping.jsonl` 是無損的索引。它回答三個問題：舊識別碼對到哪個新識別碼、正規化紀錄的來源在哪裡、`raw/` 的檔案和來源哪個檔案相同。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `entity` | string | 是 | `work`、`event`、`evidence`、`signal`、`knowledge` 或 `raw` |
| `layer` | string | 是 | 來源層，`project` 或 `global` |
| `sourceRoot` | string | 是 | `raw/project` 或 `raw/global`，必須和 `layer` 一致 |
| `sourceId` | string | 是 | 來源識別碼；`raw` 時是來源檔案在該層內的相對路徑 |
| `sourceRecord` | string | 條件式 | 非 `raw` 時必填，用來定位檔案內的單筆記錄 |
| `targetId` | string | 是 | 新識別碼；`raw` 時是套件內的 `raw/project/...` 或 `raw/global/...` 路徑 |
| `sourceRef` | string | 是 | 套件內的安全相對路徑，必須在 `sourceRoot` 底下，且檔案要存在 |
| `sha256` | string | 條件式 | `entity` 是 `raw` 時必填，必須和檔案內容相符 |
| `note` | string | 否 | 對應的補充說明 |

`sourceRoot`、`sourceRef` 與 `layer` 的關係：

- `layer` 是 `project` 時，`sourceRoot` 必須是 `raw/project`，`sourceRef` 必須以 `raw/project/` 開頭。
- `layer` 是 `global` 時，`sourceRoot` 必須是 `raw/global`，`sourceRef` 必須以 `raw/global/` 開頭。
- `sourceRef` 只能是套件內相對路徑，不能是絕對路徑，也不能包含 `..`。它指向的檔案必須存在。

`sourceRecord` 的規則：

- `entity` 不是 `raw` 時必填。值是檔案內的定位點：JSON、JSONL、YAML 這類結構化檔案用 JSON Pointer，例如 `/tasks/t-old-format` 或 `/3`；Markdown frontmatter 用 `frontmatter`，本文用 `body`。
- `entity` 是 `raw` 時不能出現 `sourceRecord`。raw mapping 的 `sourceId` 是來源檔案的相對路徑，`sourceRef` 與 `targetId` 必須相同，`sha256` 指向那個檔案的內容。

同一組 `entity`、`layer`、`sourceId` 只能出現一次。`raw/` 的每個檔案都必須有一筆 `entity: "raw"` 的 mapping，而且 `targetId` 必須對到實際存在的檔案。反過來，mapping 指到的 raw 檔案也必須存在。knowledge mapping 的 `layer` 要與知識項目的 `layer` 一致，`targetId` 要對到存在的 `knowledgeId`。

範例：

```json
{"entity":"work","layer":"project","sourceId":"t-old-format","sourceRecord":"/tasks/t-old-format","sourceRef":"raw/project/tasks.json","sourceRoot":"raw/project","targetId":"w-task-format"}
{"entity":"raw","layer":"project","sha256":"<64 個小寫十六進位字元>","sourceId":"tasks.json","sourceRef":"raw/project/tasks.json","sourceRoot":"raw/project","targetId":"raw/project/tasks.json"}
```

同一個相對路徑出現在兩層時，用 `layer` 與 `sourceRoot` 分辨：

```json
{"entity":"raw","layer":"project","sha256":"<project 檔案的雜湊>","sourceId":"memory/topics/shared-topic.md","sourceRef":"raw/project/memory/topics/shared-topic.md","sourceRoot":"raw/project","targetId":"raw/project/memory/topics/shared-topic.md"}
{"entity":"raw","layer":"global","sha256":"<global 檔案的雜湊>","sourceId":"memory/topics/shared-topic.md","sourceRef":"raw/global/memory/topics/shared-topic.md","sourceRoot":"raw/global","targetId":"raw/global/memory/topics/shared-topic.md"}
```

## raw/

`raw/` 是來源檔案的逐位元組副本。它有三個用途：

1. 保存沒有對應到正規化欄位的資料。
2. 保存來源的原始格式、時間、編碼與換行，讓後續追查不必回頭找舊系統。
3. 用 SHA-256 證明匯出過程沒有改寫來源。

`raw/` 固定分成兩層：

- `raw/project/`：專案來源，例如專案內的 `.ultrawork/`。
- `raw/global/`：`--global` 指定的全域來源，例如使用者層的記憶目錄。

兩層各自保留來源的相對目錄結構。專案層與全域層有同一個相對路徑時，兩個檔案會分別寫在 `raw/project/` 與 `raw/global/`，不會碰撞。`manifest.source.layers` 要列出這個包包含的層，`manifest.layout.raw` 要分別記錄兩層的檔案數。

規則：

- `raw/` 只能有 `project/` 與 `global/` 兩個資料夾，這兩個資料夾都要存在，可以是空的。
- 檔案路徑是該層內的相對路徑，不能是絕對路徑，不能有 `..`。
- 內容必須和來源完全相同，包含空白、換行、BOM 與二進位內容。二進位檔不需要轉成文字，直接寫入原始位元組。
- 不要在 `raw/` 裡重新命名、排序或整理檔案。需要安全檔名時，用 mapping 記錄原名與新路徑。
- 每個檔案都要有 raw mapping 與 SHA-256。raw mapping 的 `sourceRef` 與 `targetId` 是同一條套件內路徑，`sourceId` 是該層內的來源相對路徑。
- 讀取器把 `raw/` 當成不透明位元組，不要假設它是 UTF-8 或 JSON。

範例：

```text
raw/
├── project/
│   ├── tasks.json
│   ├── assets/blob.bin
│   └── memory/topics/export-format-decision.md
└── global/
    ├── memory/topics/fixture-topic.md
    └── memory/topics/shared-topic.md
```

上例的 `memory/topics/shared-topic.md` 可以同時存在於專案層與全域層；它們是不同檔案，由 raw mapping 的 `layer` 與 `sourceRoot` 分辨。

`raw/` 是唯一可以出現來源時間戳的地方。那是來源的內容，不是匯出器產生的時間。

## 驗證匯出包

JSON Schema 使用 draft 2020-12，檔案是 `schemas/export-v1/export-v1.schema.json`。schema 的根層 `$ref` 指向 `$defs.manifest`，`$defs` 另外定義 producer、source、layout 與六種 JSONL 紀錄。`additionalProperties` 在 manifest 與所有紀錄上都是 `false`，所以未知欄位會被拒絕；`details` 是唯一的自由物件。

一份完整的驗證要依序做這些事：

1. 讀 `manifest.json`，檢查 `format`、`formatVersion` 與 `createdAt`，再套用 manifest schema。`createdAt` 必須是真實存在的 UTC 日期，不能只符合格式但日期不存在。
2. 檢查頂層項目正好是八個部分。多出的檔案、缺少的檔案、型別不對的項目都要拒絕。
3. 逐行讀五個 JSONL 檔與 `knowledge/index.jsonl`。每行都要是物件、符合 canonical JSONL（鍵排序、緊湊 JSON），記錄順序也要正確，再通過對應的 `$defs` schema。
4. 檢查各部分的識別碼唯一，`event.sequence` 唯一，mapping 的 `(entity, layer, sourceId)` 唯一。
5. 檢查 `acceptanceResults` 與 `acceptance` 逐項對齊。
6. 檢查 `manifest.layout` 的計數和實際筆數、知識版本檔數、raw 總數與各層檔案數一致。
7. 檢查 `knowledge/index.jsonl` 的版本號不重複，每個版本路徑存在，`sha256` 與 `bytes` 和檔案相符，`currentVersion` 在 `versions` 內。
8. 檢查 `raw/` 只有 `project/` 與 `global/`，兩層都存在。每個 raw 檔案都要有 mapping，mapping 的 `layer`、`sourceRoot`、`sourceRef`、`targetId` 彼此一致，`sha256` 和檔案相符。
9. 檢查每個 mapping 的 `sourceRef` 是套件內安全相對路徑、在對應的 `sourceRoot` 底下且存在；非 raw mapping 要有 `sourceRecord`，raw mapping 不能有；knowledge mapping 的 `layer` 與目標知識項目一致。
10. 檢查 evidence 的 `path` 存在，並掃描產生的內容檔案，拒絕時間戳欄位，確認 `manifest.createdAt` 沒有出現在內容或知識內文裡。

專案內的測試指令：

```sh
bun test tests/export-format
```

測試會驗證一份範例包、缺少必填欄位、錯誤的 `formatVersion`、未知的頂層檔案、不合法的狀態與條件式欄位、canonical JSONL、專案層與全域層的同路徑 raw、legacy title fallback、work 的規劃與驗收欄位、mapping 的來源定位與路徑安全、binary raw、重複的識別碼與 mapping、時間戳洩漏、raw 與知識的雜湊、evidence path、知識版本重複、完整日期、空套件，以及同一輸入重跑的位元組穩定性。

## 已知風險與匯入器的責任

v1 的套件驗證器已經檢查 evidence path 存在、知識版本號重複與 `manifest.createdAt` 的完整日期合法性。以下是格式刻意留給匯入器處理的部分，匯入器不能假設套件驗證器已經處理：

- `mapping.sourceRecord` 只驗證語法。JSON Pointer 指到的內容是否存在、`frontmatter` 是否真的可解析，由匯入器在解析 `sourceRef` 時檢查；找不到就記 warning，不要讓整包匯入失敗。
- `evidence.sha256` 是選填欄位。有填時，匯入器要比對 `path` 的內容；套件驗證器只檢查 `path` 存在。沒有填時，匯入器不能自行推算或補值。
- `raw/` 的檔案名稱限制為 ASCII 安全路徑。來源檔名有空白、中文或其他字元時，匯出器要產生安全名稱，並在 mapping 的 `sourceId` 或 `note` 保留原名。讀取器不要從 raw 檔名反推語意。
- `knowledge/` 的版本內容是 UTF-8 Markdown。v1 不支援二進位知識內容；需要保存二進位檔時放進 `raw/`，用 evidence 或 mapping 指向它。
- `--global` 的實際來源路徑屬執行環境資訊，不寫進 manifest。包內只用 `layer`、`sourceRoot` 與 raw 路徑表達分層。

## formatVersion 的升級規則

`formatVersion` 是整數，不是 semver，也不是字串。v1 的值是 `1`。v1 尚未發布；這次加入分層、規劃欄位與 canonical 檢查的修訂仍屬 v1，所以 `formatVersion` 維持 `1`。發布之後，任何欄位、列舉、路徑或序列化規則的變更都要升版。

讀取器的規則：

- 只接受自己支援的版本。v1 讀取器只接受 `1`。
- 遇到其他整數或非整數，必須在讀取內容前拒絕，回報 `UNSUPPORTED_FORMAT_VERSION`，並說明支援的版本。不要嘗試猜測、部分解析或跳過不認識的欄位。
- 舊版本需要轉換時，由明確的轉換工具處理；讀取器不會自動升級，也不會自動降級。

寫入器的規則：

- 只寫自己實作的版本。v1 寫入器只寫 `1`。
- 下列變更一定會升版：
  - 新增、移除、改名或改變任何欄位的型別、必填性或意思。
  - 改變列舉值，例如狀態或 resolution。
  - 改變套件結構、固定路徑、JSONL 規則或標準序列化規則。
  - 改變識別碼、路徑、雜湊或時間戳的規則。
  - 讓舊讀取器必須改變行為才能正確解讀的任何變更。
- 只改文件措辭、補充範例、修正錯字，不改 schema 與行為時，不升版。
- v1 的 schema 拒絕未知欄位，所以「新增一個可選欄位」也是破壞性變更，必須升版。不要在 v1 的 schema 上直接加欄位。
- 升版時要建立新的 schema 目錄（例如 `schemas/export-v2/`）與新的規格文件，舊版 schema 保留，讓既有工具可以繼續讀舊包。
- `format` 字串不變，仍然是 `smilework-export`。版本只由 `formatVersion` 區分。

## 版本紀錄

| 版本 | 日期 | 變更 |
| --- | --- | --- |
| 1 | 2026-11-07 | v1：manifest、work、events、evidence、signals、knowledge、mapping、raw；包含專案層與全域層 raw、canonical JSONL、work 規劃與驗收欄位 |
