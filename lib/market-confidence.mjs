export const MARKET_FRESH_MS = 15 * 60000;
export function marketConfidence(sold, active, match, time = Date.now()) {
  const times = [sold.fetched_at, active.fetched_at].map(Date.parse);
  const fresh = times.every(t => Number.isFinite(t) && t <= time + 60000 && time - t <= MARKET_FRESH_MS);
  const capped = Boolean(sold.sampleCapped || active.sampleCapped);
  const prices = (sold.listings || []).map(x => x.totalPrice).filter(x => Number.isFinite(x) && x > 0);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const dispersion = prices.length > 1 ? Math.sqrt(prices.reduce((s, x) => s + (x - mean) ** 2, 0) / prices.length) / mean : null;
  const dated = (sold.listings || []).filter(x => {
    const date = Date.parse(x.soldDate);
    return Number.isFinite(date) && date <= time && time - date <= 90 * 86400000;
  }).length;
  const reasons = [];
  if (!sold.ok || !active.ok) reasons.push('Provider unavailable');
  if (!fresh) reasons.push('Market data stale or timestamp unknown');
  if (capped) reasons.push('Provider sample capped; counts are not market totals');
  if (!['High', 'Exact identifier'].includes(match.level)) reasons.push('Match needs verification');
  if (dated < 3 || (active.listings || []).length < 2) reasons.push('Insufficient market sample');
  if (dispersion == null || dispersion > 0.5) reasons.push('Price dispersion high or unknown');
  const level = reasons.length ? 'Low' : dated >= 10 && active.listings.length >= 5 && dispersion <= 0.25 ? 'High' : 'Medium';
  return { level, fresh, sampleCapped: capped, fetchedAt: times.every(Number.isFinite) ? new Date(Math.min(...times)).toISOString() : null, dispersion, reasons };
}

export function opportunityQuality(snapshot, time = Date.now()) {
  const fetched = Date.parse(snapshot.marketFetchedAt);
  return snapshot.profitStatus === 'PROFITABLE'
    && (!snapshot.decisionIntelligence || snapshot.decisionIntelligence.verdict?.label === 'BUY')
    && ['High', 'Medium'].includes(snapshot.marketConfidence)
    && ['High', 'Exact identifier'].includes(snapshot.matchingConfidence)
    && snapshot.sampleCapped === false && Number.isFinite(fetched) && fetched <= time + 60000 && time - fetched <= MARKET_FRESH_MS
    && snapshot.estimatedProfit >= 25 && snapshot.roi >= 40;
}
