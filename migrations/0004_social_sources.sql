ALTER TABLE items ADD COLUMN analysis_required INTEGER NOT NULL DEFAULT 1
  CHECK (analysis_required IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_items_analysis_queue
  ON items(analysis_required, status, dead_lettered_at, next_retry_at, discovered_at);
