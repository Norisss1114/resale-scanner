export const RETENTION_DAYS = 90;

export function stableDealKey(deal = {}) {
  const retailer = normalize(deal.retailer);
  const identifier = digits(deal.upc) || digits(deal.gtin);
  if (identifier) return `id:${identifier}`;
  if (deal.sku) return `sku:${retailer}:${normalize(deal.sku)}`;
  const url = normalizeProductUrl(deal.productUrl);
  if (url) return `url:${retailer}:${url}`;
  if (deal.brand && deal.model) return `model:${retailer}:${normalize(deal.brand)}:${normalize(deal.model)}`;
  return `title:${retailer}:${normalize(deal.title)}`;
}

export function snapshotFromAnalysis(item, scanRunId, detectedAt = new Date().toISOString()) {
  const deal = item.deal || {};
  const analysis = item.analysis || {};
  return {
    id: crypto.randomUUID(), scanRunId, dealKey: stableDealKey(deal), retailer: deal.retailer, title: deal.title,
    productUrl: deal.productUrl || null, imageUrl: deal.imageUrl || null,
    regularPrice: number(deal.regularPrice), salePrice: number(deal.salePrice), discountPercent: number(deal.discountPercent),
    estimatedSellPrice: number(analysis.market?.targetSalePrice), estimatedProfit: number(analysis.profit?.netProfit), roi: number(analysis.profit?.roi),
    sold7d: number(analysis.sold?.count7d), sold30d: number(analysis.sold?.count30d), sold90d: number(analysis.sold?.count90d),
    activeCount: number(analysis.active?.count), sellThrough: number(analysis.market?.sellThrough90d),
    dealScore: number(item.dealScore?.score), localScore: number(item.localScore?.score), decision: item.verdict?.label || null,
    matchingConfidence: item.matchingConfidence?.level || null, availabilityType: deal.availabilityType || 'unknown',
    localAvailabilityStatus: deal.localAvailabilityStatus || 'unknown', storeName: deal.storeName || null,
    storeDistanceMiles: number(deal.storeDistanceMiles), detectedAt
  };
}

export function compareSnapshots(current, previous = [], historicalKeys = new Set()) {
  const prior = new Map(previous.map(item => [item.dealKey, item]));
  const events = [];
  for (const snapshot of current) {
    const before = prior.get(snapshot.dealKey);
    if (!before) {
      events.push(event(snapshot, historicalKeys.has(snapshot.dealKey) ? 'returned' : 'new_deal'));
      if (isStrong(snapshot)) events.push(event(snapshot, 'became_strong', null, snapshot.dealScore));
      continue;
    }
    const drop = finite(before.salePrice) != null && finite(snapshot.salePrice) != null ? before.salePrice - snapshot.salePrice : 0;
    const dropPercent = before.salePrice > 0 ? drop / before.salePrice * 100 : 0;
    if (drop >= 5 || dropPercent >= 5) events.push(event(snapshot, 'price_drop', before.salePrice, snapshot.salePrice, { amount: drop, percent: dropPercent }));
    if (delta(snapshot.estimatedProfit, before.estimatedProfit) >= 10) events.push(event(snapshot, 'profit_increase', before.estimatedProfit, snapshot.estimatedProfit));
    if (delta(snapshot.dealScore, before.dealScore) >= 10) events.push(event(snapshot, 'score_increase', before.dealScore, snapshot.dealScore));
    if (snapshot.decision === 'BUY' && before.decision !== 'BUY') events.push(event(snapshot, 'became_buy', null, null, { previousDecision: before.decision }));
    if (isStrong(snapshot) && !isStrong(before)) events.push(event(snapshot, 'became_strong', before.dealScore, snapshot.dealScore));
    if (availabilityRank(snapshot.localAvailabilityStatus) > availabilityRank(before.localAvailabilityStatus)) events.push(event(snapshot, 'availability_improved', null, null, { previous: before.localAvailabilityStatus, current: snapshot.localAvailabilityStatus }));
  }
  return dedupeEvents(events);
}

export function dedupeEvents(events) {
  return [...new Map(events.map(item => [`${item.scanRunId}|${item.dealKey}|${item.eventType}`, item])).values()];
}

export function isStrong(snapshot = {}) {
  return snapshot.dealScore >= 80 && snapshot.estimatedProfit >= 25 && snapshot.roi >= 40 && snapshot.matchingConfidence !== 'Low';
}

export function notificationEligible(events, snapshot) {
  const types = new Set((events || []).map(item => item.eventType));
  return types.has('became_buy') || (types.has('new_deal') && isStrong(snapshot)) || (types.has('price_drop') && snapshot?.decision === 'BUY');
}

export function sortOpportunities(items) {
  return [...items].sort((a, b) => {
    const priority = opportunityPriority(b) - opportunityPriority(a);
    if (priority) return priority;
    return finite(b.snapshot?.dealScore, 0) - finite(a.snapshot?.dealScore, 0)
      || finite(b.snapshot?.estimatedProfit, 0) - finite(a.snapshot?.estimatedProfit, 0)
      || finite(b.snapshot?.localScore, 0) - finite(a.snapshot?.localScore, 0);
  });
}

export function scanRunStatus({ providerStatuses = [], analyzed = 0, errors = 0 }) {
  const providerFailures = providerStatuses.filter(item => ['error', 'unavailable'].includes(item.status)).length;
  if (analyzed === 0) return 'failed';
  if (providerFailures || errors) return 'partial';
  return 'completed';
}

export function retentionCutoff(now = new Date(), days = RETENTION_DAYS) {
  return new Date(now.getTime() - days * 86400000).toISOString();
}

function opportunityPriority(item) {
  const types = new Set((item.events || []).map(event => event.eventType));
  if (types.has('became_buy')) return 6;
  if (types.has('price_drop') && isStrong(item.snapshot)) return 5;
  if (types.has('new_deal') && isStrong(item.snapshot)) return 4;
  if (types.has('price_drop')) return 3;
  if (types.has('profit_increase')) return 2;
  if (types.has('score_increase')) return 1;
  return 0;
}
function event(snapshot, eventType, previousValue = null, currentValue = null, metadata = null) { return { id: crypto.randomUUID(), scanRunId: snapshot.scanRunId, dealKey: snapshot.dealKey, eventType, retailer: snapshot.retailer, title: snapshot.title, previousValue, currentValue, metadata, createdAt: snapshot.detectedAt }; }
function normalizeProductUrl(value) { try { const url = new URL(value); url.hash = ''; url.search = ''; return `${url.hostname}${url.pathname}`.replace(/\/$/, '').toLowerCase(); } catch { return null; } }
function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-'); }
function digits(value) { const result = String(value || '').replace(/\D/g, ''); return result.length >= 8 && result.length <= 14 ? result : null; }
function number(value) { const result = Number(value); return value != null && value !== '' && Number.isFinite(result) ? result : null; }
function finite(value, fallback = null) { const result = Number(value); return value != null && value !== '' && Number.isFinite(result) ? result : fallback; }
function delta(current, previous) { const now = finite(current); const before = finite(previous); return now == null || before == null ? 0 : now - before; }
function availabilityRank(value) { return { unavailable: 0, unknown: 1, likely: 2, confirmed: 3 }[value] ?? 1; }
