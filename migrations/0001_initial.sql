-- 初始 schema：專案、工作、事件、證據、訊號、知識、使用量與匯入對應。
-- 所有時間欄位都是 UTC ISO 8601 字串；JSON 欄位以 TEXT 儲存。

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  common_dir TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_projects_common_dir ON projects(common_dir);

CREATE TABLE project_worktrees (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  worktree_path TEXT NOT NULL,
  git_dir TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, worktree_path)
) STRICT;

CREATE UNIQUE INDEX idx_project_worktrees_path ON project_worktrees(worktree_path);

CREATE TABLE work_items (
  work_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'plan')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('completed', 'failed', 'abandoned')),
  owner TEXT NOT NULL,
  priority TEXT NOT NULL,
  plan_id TEXT,
  objective TEXT,
  non_goals TEXT NOT NULL DEFAULT '[]',
  context_refs TEXT NOT NULL DEFAULT '[]',
  scope_paths TEXT NOT NULL DEFAULT '[]',
  acceptance TEXT NOT NULL DEFAULT '[]',
  risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
  review TEXT,
  reviewed_version INTEGER,
  acceptance_results TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_model TEXT,
  updated_by TEXT NOT NULL,
  updated_by_model TEXT,
  CHECK (
    (status = 'done' AND resolution IN ('completed', 'failed')) OR
    (status = 'cancelled' AND resolution = 'abandoned') OR
    (status NOT IN ('done', 'cancelled') AND resolution IS NULL)
  )
) STRICT;

CREATE INDEX idx_work_items_project_status ON work_items(project_id, status);
CREATE INDEX idx_work_items_plan ON work_items(project_id, plan_id);

CREATE TABLE work_dependencies (
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON UPDATE CASCADE ON DELETE CASCADE,
  depends_on_work_id TEXT NOT NULL REFERENCES work_items(work_id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_id, depends_on_work_id),
  CHECK (work_id <> depends_on_work_id)
) STRICT;

CREATE INDEX idx_work_dependencies_dep ON work_dependencies(depends_on_work_id);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_model TEXT,
  work_id TEXT,
  from_status TEXT,
  to_status TEXT,
  resolution TEXT,
  summary TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, sequence)
) STRICT;

CREATE INDEX idx_events_work ON events(project_id, work_id, sequence);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON UPDATE CASCADE ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('command', 'test', 'review', 'link', 'note', 'artifact')),
  actor TEXT NOT NULL,
  actor_model TEXT,
  summary TEXT NOT NULL,
  command TEXT,
  output TEXT,
  output_path TEXT,
  url TEXT,
  path TEXT,
  sha256 TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  server_issued INTEGER NOT NULL DEFAULT 0 CHECK (server_issued IN (0, 1)),
  details TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind <> 'link' OR url IS NOT NULL),
  CHECK (kind <> 'artifact' OR path IS NOT NULL),
  CHECK (kind NOT IN ('command', 'test') OR command IS NOT NULL)
) STRICT;

CREATE INDEX idx_evidence_work ON evidence(project_id, work_id);

CREATE TABLE signals (
  signal_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) <= 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'accepted', 'dismissed')),
  work_id TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  result_refs TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  details TEXT,
  severity TEXT CHECK (severity IS NULL OR severity IN ('info', 'warning', 'error')),
  code TEXT CHECK (code IS NULL OR length(code) <= 64),
  actor TEXT NOT NULL,
  actor_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK ((scope = 'project' AND project_id IS NOT NULL) OR (scope = 'global' AND project_id IS NULL))
) STRICT;

CREATE INDEX idx_signals_status ON signals(status, created_at);
CREATE INDEX idx_signals_kind ON signals(kind);
CREATE INDEX idx_signals_code ON signals(code);

CREATE TABLE knowledge_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('project', 'global')),
  project_id TEXT REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('memory', 'skill', 'document')),
  type TEXT NOT NULL CHECK (type IN ('decision', 'reference', 'lesson', 'pitfall', 'preference', 'document')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  source TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  current_version INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  work_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_model TEXT,
  updated_by TEXT NOT NULL,
  updated_by_model TEXT,
  CHECK ((layer = 'project' AND project_id IS NOT NULL) OR (layer = 'global' AND project_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX idx_knowledge_entries_scope
  ON knowledge_entries(knowledge_id, layer, COALESCE(project_id, ''));
CREATE INDEX idx_knowledge_entries_status ON knowledge_entries(status, layer);

CREATE TABLE knowledge_versions (
  entry_id INTEGER NOT NULL REFERENCES knowledge_entries(id) ON UPDATE CASCADE ON DELETE CASCADE,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  snapshot_path TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_model TEXT,
  reason TEXT,
  source_signal_ids TEXT NOT NULL DEFAULT '[]',
  work_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, version)
) STRICT;

CREATE INDEX idx_knowledge_versions_sha ON knowledge_versions(sha256);

CREATE TABLE usage_events (
  usage_id TEXT PRIMARY KEY,
  project_id TEXT,
  layer TEXT,
  knowledge_id TEXT,
  version INTEGER,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_model TEXT,
  query TEXT,
  details TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_usage_events_knowledge ON usage_events(knowledge_id, created_at);

CREATE TABLE idempotency_keys (
  project_id TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, tool, key)
) STRICT;

CREATE TABLE id_mappings (
  entity TEXT NOT NULL,
  layer TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_root TEXT,
  source_record TEXT,
  target_id TEXT NOT NULL,
  source_ref TEXT,
  sha256 TEXT,
  note TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (entity, layer, source_id)
) STRICT;

CREATE INDEX idx_id_mappings_target ON id_mappings(target_id);

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
