import { isStrong, notificationEligible, retentionCutoff, sortOpportunities } from './monitoring.mjs';

export function monitoringAvailable(env) { return Boolean(env?.DB?.prepare); }

export async function acquireScheduledRun(env, now = new Date()) {
  if (!monitoringAvailable(env)) return { acquired: false, reason: 'D1 unavailable' };
  const hourStart = new Date(now); hourStart.setUTCMinutes(0, 0, 0);
  const runId = `scheduled_${hourStart.toISOString()}`;
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO scan_runs (id, started_at, trigger_type, status) VALUES (?, ?, 'scheduled', 'running')").bind(runId, now.toISOString()).run();
  if (inserted?.meta?.changes === 0) return { acquired: false, reason: 'duplicate_window', runId };
  return { acquired: true, runId };
}

export async function previousSnapshots(env, currentRunId) {
  const run = await env.DB.prepare("SELECT id FROM scan_runs WHERE id <> ? AND status IN ('completed','partial') ORDER BY completed_at DESC LIMIT 1").bind(currentRunId).first();
  if (!run) return { snapshots: [], historicalKeys: new Set() };
  const previous = await env.DB.prepare('SELECT * FROM deal_snapshots WHERE scan_run_id = ?').bind(run.id).all();
  const historical = await env.DB.prepare('SELECT DISTINCT deal_key FROM deal_snapshots WHERE scan_run_id <> ?').bind(run.id).all();
  return { snapshots: (previous.results || []).map(fromRow), historicalKeys: new Set((historical.results || []).map(row => row.deal_key)) };
}

export async function saveMonitoringResult(env, run, snapshots, events) {
  const statements = snapshots.map(item => env.DB.prepare(`INSERT OR IGNORE INTO deal_snapshots (
    id, scan_run_id, deal_key, retailer, title, product_url, image_url, regular_price, sale_price, discount_percent,
    estimated_sell_price, estimated_profit, roi, sold_7d, sold_30d, sold_90d, active_count, sell_through,
    deal_score, local_score, decision, matching_confidence, availability_type, local_availability_status,
    store_name, store_distance_miles, detected_at, profit_status, market_data_status, match_method, profit_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.id, item.scanRunId, item.dealKey, item.retailer, item.title, item.productUrl, item.imageUrl, item.regularPrice, item.salePrice, item.discountPercent, item.estimatedSellPrice, item.estimatedProfit, item.roi, item.sold7d, item.sold30d, item.sold90d, item.activeCount, item.sellThrough, item.dealScore, item.localScore, item.decision, item.matchingConfidence, item.availabilityType, item.localAvailabilityStatus, item.storeName, item.storeDistanceMiles, item.detectedAt, item.profitStatus, item.marketDataStatus, item.matchMethod, item.profitReason));
  statements.push(...events.map(item => env.DB.prepare(`INSERT OR IGNORE INTO deal_events (id, scan_run_id, deal_key, event_type, retailer, title, previous_value, current_value, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.id, item.scanRunId, item.dealKey, item.eventType, item.retailer, item.title, item.previousValue, item.currentValue, item.metadata ? JSON.stringify(item.metadata) : null, item.createdAt)));
  if (statements.length) await env.DB.batch(statements);
  await env.DB.prepare(`UPDATE scan_runs SET completed_at = ?, status = ?, total_deals = ?, analyzed_deals = ?, buy_count = ?, maybe_count = ?, skip_count = ?, new_count = ?, price_drop_count = ?, error_count = ?, provider_summary = ? WHERE id = ?`)
    .bind(run.completedAt, run.status, run.totalDeals, run.analyzedDeals, run.buyCount, run.maybeCount, run.skipCount, run.newCount, run.priceDropCount, run.errorCount, JSON.stringify(run.providerSummary), run.id).run();
}

export async function markRunFailed(env, runId, error) {
  if (!monitoringAvailable(env) || !runId) return;
  await env.DB.prepare("UPDATE scan_runs SET completed_at = ?, status = 'failed', error_count = 1, provider_summary = ? WHERE id = ?").bind(new Date().toISOString(), JSON.stringify({ error: error?.message || String(error) }), runId).run();
}

export async function cleanupMonitoring(env, now = new Date()) {
  if (!monitoringAvailable(env)) return { available: false, deleted: false };
  const cutoff = retentionCutoff(now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deal_events WHERE created_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM deal_snapshots WHERE detected_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM scan_runs WHERE started_at < ?').bind(cutoff)
  ]);
  return { available: true, deleted: true, cutoff };
}

export async function getScanHistory(env, limit = 20) {
  if (!monitoringAvailable(env)) return unavailable();
  const result = await env.DB.prepare('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?').bind(Math.min(20, Math.max(1, Number(limit) || 20))).all();
  return { available: true, scans: result.results || [] };
}

export async function getLatestScan(env) {
  if (!monitoringAvailable(env)) return unavailable();
  const scan = await env.DB.prepare("SELECT * FROM scan_runs WHERE trigger_type = 'scheduled' ORDER BY started_at DESC LIMIT 1").first();
  return { available: true, scan: scan || null };
}

export async function getTodaysOpportunities(env, now = new Date()) {
  if (!monitoringAvailable(env)) return unavailable();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const result = await env.DB.prepare(`SELECT e.*, s.sale_price, s.regular_price, s.estimated_profit, s.roi, s.deal_score, s.local_score, s.decision, s.matching_confidence, s.product_url, s.image_url, s.profit_status, s.market_data_status, s.match_method, s.profit_reason
    FROM deal_events e JOIN deal_snapshots s ON s.scan_run_id = e.scan_run_id AND s.deal_key = e.deal_key
    WHERE e.created_at >= ? ORDER BY e.created_at DESC`).bind(since).all();
  const grouped = new Map();
  for (const row of result.results || []) {
    const key = `${row.scan_run_id}|${row.deal_key}`;
    if (!grouped.has(key)) grouped.set(key, { snapshot: snapshotFromJoinedRow(row), events: [] });
    grouped.get(key).events.push({ eventType: row.event_type, previousValue: row.previous_value, currentValue: row.current_value, metadata: parseJson(row.metadata) });
  }
  const opportunities = sortOpportunities([...grouped.values()]).map(item => ({ ...item, notificationEligible: notificationEligible(item.events, item.snapshot) }));
  return {
    available: true, opportunities,
    summary: {
      total: opportunities.length,
      strong: opportunities.filter(item => isStrong(item.snapshot) || item.snapshot.decision === 'BUY').length,
      newDeals: opportunities.filter(item => item.events.some(event => event.eventType === 'new_deal')).length,
      priceDrops: opportunities.filter(item => item.events.some(event => event.eventType === 'price_drop')).length,
      potentialProfit: opportunities.reduce((sum, item) => item.snapshot.profitStatus === 'PROFITABLE' && Number.isFinite(item.snapshot.estimatedProfit) ? sum + Math.max(0, item.snapshot.estimatedProfit) : sum, 0)
    }
  };
}

function fromRow(row) { return { dealKey: row.deal_key, salePrice: row.sale_price, estimatedProfit: row.estimated_profit, roi: row.roi, dealScore: row.deal_score, localScore: row.local_score, decision: row.decision, matchingConfidence: row.matching_confidence, localAvailabilityStatus: row.local_availability_status, profitStatus: row.profit_status || null, marketDataStatus: row.market_data_status || null, matchMethod: row.match_method || null, profitReason: row.profit_reason || null }; }
function snapshotFromJoinedRow(row) { return { scanRunId: row.scan_run_id, dealKey: row.deal_key, retailer: row.retailer, title: row.title, productUrl: row.product_url, imageUrl: row.image_url, regularPrice: row.regular_price, salePrice: row.sale_price, estimatedProfit: row.estimated_profit, roi: row.roi, dealScore: row.deal_score, localScore: row.local_score, decision: row.decision, matchingConfidence: row.matching_confidence, profitStatus: row.profit_status || null, marketDataStatus: row.market_data_status || null, matchMethod: row.match_method || null, profitReason: row.profit_reason || null }; }
function unavailable() { return { available: false, status: 'unavailable', error: 'Automated monitoring unavailable: D1 binding DB is not configured' }; }
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
