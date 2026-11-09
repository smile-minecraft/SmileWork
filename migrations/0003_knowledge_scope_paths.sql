-- 知識項目適用的專案內相對路徑 glob；空陣列代表不自動帶入。
ALTER TABLE knowledge_entries ADD COLUMN scope_paths TEXT NOT NULL DEFAULT '[]';
