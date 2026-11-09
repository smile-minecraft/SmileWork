-- 工作建立時的 git HEAD；非 git 專案或舊資料為 NULL。
ALTER TABLE work_items ADD COLUMN base_commit TEXT;
