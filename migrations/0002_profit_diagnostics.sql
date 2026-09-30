ALTER TABLE deal_snapshots ADD COLUMN profit_status TEXT;
ALTER TABLE deal_snapshots ADD COLUMN market_data_status TEXT;
ALTER TABLE deal_snapshots ADD COLUMN match_method TEXT;
ALTER TABLE deal_snapshots ADD COLUMN profit_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_snapshots_profit_status ON deal_snapshots(profit_status);
CREATE INDEX IF NOT EXISTS idx_snapshots_market_status ON deal_snapshots(market_data_status);
