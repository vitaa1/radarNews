ALTER TABLE items ADD COLUMN alert_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN alert_next_retry_at TEXT;
ALTER TABLE items ADD COLUMN alert_dead_lettered_at TEXT;
ALTER TABLE items ADD COLUMN analysis_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN analysis_next_retry_at TEXT;
ALTER TABLE items ADD COLUMN analysis_dead_lettered_at TEXT;

CREATE INDEX idx_items_alert_retry
  ON items(alert_dead_lettered_at, alert_sent_at, alert_next_retry_at, discovered_at);
CREATE INDEX idx_items_analysis_retry
  ON items(status, analysis_dead_lettered_at, analysis_next_retry_at, analysis_ready_at);
