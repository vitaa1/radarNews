ALTER TABLE items ADD COLUMN next_retry_at TEXT;
ALTER TABLE items ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE items ADD COLUMN alert_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN alert_last_attempt_at TEXT;
ALTER TABLE items ADD COLUMN alert_message_id INTEGER;
ALTER TABLE items ADD COLUMN analysis_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN analysis_last_attempt_at TEXT;
ALTER TABLE items ADD COLUMN analysis_message_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_items_processing_retry
  ON items(status, dead_lettered_at, next_retry_at, retry_count, discovered_at);

CREATE INDEX IF NOT EXISTS idx_items_dead_letter
  ON items(dead_lettered_at, discovered_at);
