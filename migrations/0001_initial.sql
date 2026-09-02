CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('ignored', 'pending', 'processing', 'ready', 'processed')),
  alert_sent_at TEXT,
  alert_error TEXT,
  claim_token TEXT,
  claim_expires_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  analysis_json TEXT,
  analysis_ready_at TEXT,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_status_discovered
  ON items(status, discovered_at ASC);

CREATE INDEX IF NOT EXISTS idx_items_alert_pending
  ON items(alert_sent_at, discovered_at ASC);

CREATE INDEX IF NOT EXISTS idx_items_claim_token
  ON items(claim_token);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
