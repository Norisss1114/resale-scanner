import { matchProfile } from './product-matching.mjs';
export const DEAL_SCORE_WEIGHTS = Object.freeze({
  profit: 0.30,
  roi: 0.20,
  demand: 0.20,
  sellThrough: 0.15,
  discount: 0.10,
  competition: 0.05
});

export function calculateDealScore(input, weights = DEAL_SCORE_WEIGHTS) {
  const components = {
    profit: scale(input.estimatedProfit, 0, 75),
    roi: scale(input.roi, 0, 150),
    demand: scale(input.sold90, 0, 40),
    sellThrough: scale(input.sellThrough, 0, 150),
    discount: clamp(input.discountPercent),
    competition: Number.isFinite(Number(input.activeCount)) && input.activeCount != null
      ? 100 - scale(input.activeCount, 0, 100)
      : 0
  };
  const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key] * weight, 0);
  return { score: Math.round(clamp(score)), label: dealScoreLabel(score), components };
}

export function dealScoreLabel(score) {
  if (score >= 80) return 'Strong opportunity';
  if (score >= 65) return 'Good';
  if (score >= 50) return 'Maybe';
  return 'Weak';
}

export function filterDeals(items, filters = {}) {
  const minimumProfit = finiteOr(filters.minimumProfit, 25);
  const minimumRoi = finiteOr(filters.minimumRoi, 40);
  const minimumDiscount = finiteOr(filters.minimumDiscount, 0);
  const retailer = String(filters.retailer || 'all').toLowerCase();
  const sourceType = String(filters.sourceType || 'all').toLowerCase();
  const verdict = String(filters.verdict || 'all').toUpperCase();
  const inStockOnly = filters.inStockOnly === true || filters.inStockOnly === 'true';
  const withinRadiusOnly = truthy(filters.withinRadiusOnly);
  const pickupOnly = truthy(filters.pickupOnly);
  const confirmedOnly = truthy(filters.confirmedOnly);
  return items.filter(item => {
    if (item.status !== 'OK' && item.status !== 'PARTIAL') return false;
    const profit = item.analysis?.profit?.netProfit;
    const roi = item.analysis?.profit?.roi;
    return (profit == null || finiteOr(profit, -Infinity) >= minimumProfit)
      && (roi == null || finiteOr(roi, -Infinity) >= minimumRoi)
      && finiteOr(item.deal?.discountPercent, 0) >= minimumDiscount
      && (retailer === 'all' || String(item.deal?.retailer || '').toLowerCase() === retailer)
      && (sourceType === 'all' || String(item.deal?.sourceType || '').toLowerCase() === sourceType)
      && (verdict === 'ALL' || String(item.verdict?.label || '').toUpperCase() === verdict)
      && (!inStockOnly || item.deal?.availability === 'in_stock')
      && (!withinRadiusOnly || item.deal?.withinRadius === true)
      && (!pickupOnly || item.deal?.pickupAvailable === true)
      && (!confirmedOnly || item.deal?.localAvailabilityStatus === 'confirmed');
  });
}

export function sortDeals(items, sortBy = 'dealScore') {
  const getters = {
    dealScore: item => item.dealScore?.score,
    estimatedProfit: item => item.analysis?.profit?.netProfit,
    roi: item => item.analysis?.profit?.roi,
    discount: item => item.deal?.discountPercent,
    sold90: item => item.analysis?.sold?.count90d,
    bestNearby: item => bestNearbyRank(item)
  };
  const getter = getters[sortBy] || getters.dealScore;
  return [...items].sort((a, b) => finiteOr(getter(b), -Infinity) - finiteOr(getter(a), -Infinity));
}

export function calculateLocalScore(input = {}) {
  const distance = Number(input.distanceMiles);
  const radius = Math.max(1, Number(input.radiusMiles) || 15);
  const distanceScore = Number.isFinite(distance) ? clamp((1 - Math.min(distance, radius) / radius) * 100) : 0;
  const pickupScore = input.pickupAvailable === true ? 100 : input.pickupAvailable === false ? 0 : 25;
  const confidenceScore = { confirmed: 100, likely: 65, unknown: 20, unavailable: 0 }[input.localAvailabilityStatus] ?? 20;
  const score = distanceScore * 0.45 + pickupScore * 0.25 + confidenceScore * 0.30;
  return {
    score: Math.round(clamp(score)),
    label: score >= 80 ? 'Excellent nearby fit' : score >= 60 ? 'Good nearby fit' : score >= 35 ? 'Limited local signal' : 'Local data weak',
    components: { distance: Math.round(distanceScore), pickup: pickupScore, confidence: confidenceScore }
  };
}

export function bestNearbyRank(item) {
  const verdict = { BUY: 3, MAYBE: 2, SKIP: 1 }[item.verdict?.label] || 0;
  const dealScore = finiteOr(item.dealScore?.score, 0);
  const localScore = finiteOr(item.localScore?.score, 0);
  const distance = finiteOr(item.deal?.storeDistanceMiles, 999);
  return verdict * 1_000_000 + dealScore * 10_000 + localScore * 100 - Math.min(distance, 999);
}

export function decideDealVerdict({ analysis, dealScore, matchingConfidence = 'High', minimumProfit = 25, minimumRoi = 40 }) {
  // Legacy export retained for older consumers; current scans share the decision engine.
  if (analysis?.decisionIntelligence) return analysis.decisionIntelligence.verdict;
  const profit = analysis?.profit?.netProfit;
  const roi = analysis?.profit?.roi;
  const sold90 = analysis?.sold?.count90d;
  const sellThrough = analysis?.market?.sellThrough90d;
  if (!Number.isFinite(profit) || !Number.isFinite(roi) || sold90 == null) {
    return { label: 'MAYBE', reasons: ['市場データまたは利益データが不足しています'] };
  }
  if (profit < 10 || roi < 20 || sold90 === 0) {
    return { label: 'SKIP', reasons: [`利益 $${profit.toFixed(2)} / ROI ${roi.toFixed(0)}% / 90日Sold ${sold90}`] };
  }
  if (profit >= minimumProfit && roi >= minimumRoi && sold90 >= 2 && dealScore.score >= 65 && (sellThrough == null || sellThrough >= 20)) {
    if (matchingConfidence === 'Low') return { label: 'MAYBE', reasons: [`利益条件を満たしますが商品一致精度がLowです。要確認 / Deal Score ${dealScore.score}`] };
    return { label: 'BUY', reasons: [`利益 $${profit.toFixed(2)} / ROI ${roi.toFixed(0)}% / Deal Score ${dealScore.score}`] };
  }
  return { label: 'MAYBE', reasons: [`利益 $${profit.toFixed(2)} / ROI ${roi.toFixed(0)}% / Deal Score ${dealScore.score}`] };
}

export function matchingConfidenceForDeal(deal = {}, matchedListings = []) {
  return matchProfile(deal, matchedListings);
}

function scale(value, min, max) {
  if (!Number.isFinite(Number(value))) return 0;
  return clamp(((Number(value) - min) / (max - min)) * 100);
}

function finiteOr(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function identifier(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function text(value) {
  return String(value || '').trim();
}

function truthy(value) { return value === true || value === 'true'; }
