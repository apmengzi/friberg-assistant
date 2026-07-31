CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  tier TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  device_hash TEXT,
  refresh_hash TEXT,
  last_seen_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  order_ref TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_license_status ON license_keys(status);
CREATE INDEX IF NOT EXISTS idx_license_expiry ON license_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_license_created ON license_keys(created_at DESC);

CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (license_id) REFERENCES license_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_license_events_license ON license_events(license_id, created_at DESC);
