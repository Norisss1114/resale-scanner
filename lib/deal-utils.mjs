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
  return items.filter(item => {
    if (item.status !== 'OK' && item.status !== 'PARTIAL') return false;
    return finiteOr(item.analysis?.profit?.netProfit, -Infinity) >= minimumProfit
      && finiteOr(item.analysis?.profit?.roi, -Infinity) >= minimumRoi
      && finiteOr(item.deal?.discountPercent, 0) >= minimumDiscount;
  });
}

export function sortDeals(items, sortBy = 'dealScore') {
  const getters = {
    dealScore: item => item.dealScore?.score,
    estimatedProfit: item => item.analysis?.profit?.netProfit,
    roi: item => item.analysis?.profit?.roi,
    discount: item => item.deal?.discountPercent,
    sold90: item => item.analysis?.sold?.count90d
  };
  const getter = getters[sortBy] || getters.dealScore;
  return [...items].sort((a, b) => finiteOr(getter(b), -Infinity) - finiteOr(getter(a), -Infinity));
}

export function decideDealVerdict({ analysis, dealScore, minimumProfit = 25, minimumRoi = 40 }) {
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
    return { label: 'BUY', reasons: [`利益 $${profit.toFixed(2)} / ROI ${roi.toFixed(0)}% / Deal Score ${dealScore.score}`] };
  }
  return { label: 'MAYBE', reasons: [`利益 $${profit.toFixed(2)} / ROI ${roi.toFixed(0)}% / Deal Score ${dealScore.score}`] };
}

function scale(value, min, max) {
  if (!Number.isFinite(Number(value))) return 0;
  return clamp(((Number(value) - min) / (max - min)) * 100);
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}
