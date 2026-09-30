export const MAX_SCAN_ANALYSES = 8;
export const MAX_PER_RETAILER = 4;

export function candidateRequestCapacity(budget, time = Date.now()) {
  if (budget?.status !== 'Healthy' || !Number.isFinite(budget.remaining) || !Number.isFinite(budget.limits?.usableMinute)) return 0;
  const used = budget.minute === Math.floor(time / 60000) ? budget.minute_count : 0;
  return Math.max(0, Math.min(budget.remaining, budget.limits.usableMinute - (Number.isFinite(used) ? used : 0)));
}

export function candidatePreScore(deal) {
  const reasons = [];
  let score = 0;
  if (Number.isFinite(deal.discountPercent) && deal.discountPercent > 0) {
    score += Math.min(30, deal.discountPercent * 0.4); reasons.push('Verified reference-price discount');
  }
  if (deal.brand) { score += 10; reasons.push('Brand supplied'); }
  if (deal.model || deal.upc || deal.gtin) { score += 20; reasons.push('Model or global identifier supplied'); }
  if (deal.sku || deal.productId) { score += 5; reasons.push('Retailer identifier supplied'); }
  if (/electronic|tool|toy|appliance|shoe|branded home/i.test(deal.category || '')) { score += 15; reasons.push('Resale-oriented category'); }
  if (deal.salePrice >= 15 && deal.salePrice <= 300) score += 10;
  if (deal.dealType === 'clearance') score += 5;
  if (deal.dataQuality === 'High') score += 5;
  if (/furniture|refrigerator|sofa|mattress/i.test(`${deal.category || ''} ${deal.title || ''}`)) { score -= 20; reasons.push('Potentially bulky; lower acquisition priority'); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, purpose: 'Analysis allocation, not resale profit or BUY confidence' };
}

export function rankCandidates(deals, { remaining = 0, maxAnalyses = MAX_SCAN_ANALYSES, maxPerRetailer = MAX_PER_RETAILER, scheduled = false } = {}) {
  const eligible = deals.filter(d => Number.isFinite(d.salePrice) && d.salePrice >= 0 && d.availability !== 'out_of_stock'
    && (!scheduled || d.discountPercent >= 30 || d.dealType === 'clearance'))
    .map(deal => ({ ...deal, preScore: candidatePreScore(deal) }))
    .sort((a, b) => b.preScore.score - a.preScore.score || String(a.id).localeCompare(String(b.id)));
  const limit = Math.min(MAX_SCAN_ANALYSES, Number.isFinite(maxAnalyses) ? Math.max(0, Math.floor(maxAnalyses)) : 0,
    Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining / 2)) : 0);
  const retailerLimit = Number.isFinite(maxPerRetailer) ? Math.min(MAX_PER_RETAILER, Math.max(0, Math.floor(maxPerRetailer))) : MAX_PER_RETAILER;
  const counts = new Map(), selected = [];
  for (const deal of eligible) {
    if (selected.length >= limit) break;
    const count = counts.get(deal.retailer) || 0;
    if (count >= retailerLimit) continue;
    selected.push(deal); counts.set(deal.retailer, count + 1);
  }
  return { selected, eligibleCount: eligible.length, deferred: eligible.length - selected.length, limit };
}
