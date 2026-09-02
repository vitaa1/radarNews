ALTER TABLE items ADD COLUMN alert_claim_token TEXT;
ALTER TABLE items ADD COLUMN alert_claim_expires_at TEXT;
ALTER TABLE items ADD COLUMN analysis_claim_token TEXT;
ALTER TABLE items ADD COLUMN analysis_claim_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_items_alert_delivery
  ON items(alert_sent_at, alert_claim_expires_at, discovered_at);

CREATE INDEX IF NOT EXISTS idx_items_analysis_delivery
  ON items(status, analysis_claim_expires_at, analysis_ready_at);
