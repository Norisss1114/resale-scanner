CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, trigger_type TEXT NOT NULL,
  status TEXT NOT NULL, total_deals INTEGER DEFAULT 0, analyzed_deals INTEGER DEFAULT 0,
  buy_count INTEGER DEFAULT 0, maybe_count INTEGER DEFAULT 0, skip_count INTEGER DEFAULT 0,
  new_count INTEGER DEFAULT 0, price_drop_count INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0,
  provider_summary TEXT
);

CREATE TABLE IF NOT EXISTS deal_snapshots (
  id TEXT PRIMARY KEY, scan_run_id TEXT NOT NULL, deal_key TEXT NOT NULL, retailer TEXT NOT NULL,
  title TEXT NOT NULL, product_url TEXT, image_url TEXT, regular_price REAL, sale_price REAL,
  discount_percent REAL, estimated_sell_price REAL, estimated_profit REAL, roi REAL,
  sold_7d INTEGER, sold_30d INTEGER, sold_90d INTEGER, active_count INTEGER, sell_through REAL,
  deal_score REAL, local_score REAL, decision TEXT, matching_confidence TEXT, availability_type TEXT,
  local_availability_status TEXT, store_name TEXT, store_distance_miles REAL, detected_at TEXT NOT NULL,
  UNIQUE(scan_run_id, deal_key)
);

CREATE TABLE IF NOT EXISTS deal_events (
  id TEXT PRIMARY KEY, scan_run_id TEXT NOT NULL, deal_key TEXT NOT NULL, event_type TEXT NOT NULL,
  retailer TEXT, title TEXT, previous_value REAL, current_value REAL, metadata TEXT, created_at TEXT NOT NULL,
  UNIQUE(scan_run_id, deal_key, event_type)
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_started ON scan_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON deal_snapshots(scan_run_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_key ON deal_snapshots(deal_key);
CREATE INDEX IF NOT EXISTS idx_events_created ON deal_events(created_at DESC);
