CREATE TABLE provider_usage (
  provider TEXT PRIMARY KEY,
  day TEXT NOT NULL DEFAULT '', minute INTEGER NOT NULL DEFAULT 0,
  daily_count INTEGER NOT NULL DEFAULT 0, minute_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0, server_errors INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0, cache_hits INTEGER NOT NULL DEFAULT 0,
  circuit_open INTEGER NOT NULL DEFAULT 0
);
INSERT INTO provider_usage(provider) VALUES ('ebay');
CREATE TABLE provider_cache (
  cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX provider_cache_expiry ON provider_cache(expires_at);
CREATE TABLE request_limits (
  scope TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL
);
ALTER TABLE deal_snapshots ADD COLUMN market_confidence TEXT;
ALTER TABLE deal_snapshots ADD COLUMN market_fetched_at TEXT;
ALTER TABLE deal_snapshots ADD COLUMN sample_capped INTEGER;
