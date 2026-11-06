# export-v3 測試資料

這些檔案是去識別化的舊版 ultrawork v3 資料樣本，只用來驗證匯出器。

## 來源

- `v2-data/`：複製自 `opencode-ultrawork` 的 `tests/v2/fixtures/v2-data/`。該目錄由舊版模組在暫存專案產生，產生後只改寫身分欄位（`projectId`、`projectPath`），格式與 hash 不受影響。
- `v2-global/`：把 `v2-data/memory/` 原樣複製成全域層樣本，用來驗證同一個相對路徑同時出現在專案層與全域層時不會互相覆蓋。

樣本不含個人姓名、家目錄路徑或真實工作資料。測試只會複製到暫存目錄後讀取，不會修改這裡的檔案。
