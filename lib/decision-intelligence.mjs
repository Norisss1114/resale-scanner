// All sale prices are item-only USD; buyer shipping is collected exactly once.
const nonnegative = x => Number.isFinite(x) && x >= 0;
const floorCent = x => Math.floor((x + 1e-9) * 100) / 100;
const ceilCent = x => Math.ceil((x - 1e-9) * 100) / 100;

export function calculateEconomics(input) {
  const { salePrice, cost, buyerShipping = 0, sellerShipping, packaging = 0.5,
    feeRate = 13.6, promotedRate = 0, fixedFee = 0.4, purchaseTaxRate = 0,
    minimumProfit = 25, minimumRoi = 40 } = input;
  const values = [salePrice, cost, buyerShipping, sellerShipping, packaging, feeRate,
    promotedRate, fixedFee, purchaseTaxRate, minimumProfit, minimumRoi];
  if (!values.every(nonnegative) || feeRate + promotedRate >= 100 || purchaseTaxRate > 100) return null;
  const fee = feeRate / 100, ads = promotedRate / 100, tax = purchaseTaxRate / 100;
  const landedCost = cost * (1 + tax);
  const fees = (salePrice + buyerShipping) * fee + fixedFee;
  const promotedCost = salePrice * ads;
  const recovery = salePrice + buyerShipping - fees - promotedCost - sellerShipping - packaging;
  // Remove binary floating-point noise at threshold boundaries, not fractional cents.
  const netProfit = Math.round((recovery - landedCost) * 1e10) / 1e10;
  const profitLimit = (recovery - minimumProfit) / (1 + tax);
  const roiLimit = recovery / (1 + minimumRoi / 100) / (1 + tax);
  const limit = Math.min(profitLimit, roiLimit);
  const requiredPrice = profit => ceilCent(Math.max(0,
    (landedCost + profit + fixedFee + sellerShipping + packaging - buyerShipping * (1 - fee)) / (1 - fee - ads)));
  if (![landedCost, recovery, netProfit, limit, requiredPrice(minimumProfit)].every(Number.isFinite)) return null;
  return { netProfit, roi: landedCost > 0 ? Math.round(netProfit / landedCost * 1e12) / 1e10 : null,
    landedCost, fees, promotedCost, grossCollected: salePrice + buyerShipping,
    maxBuyPrice: limit >= 0 ? floorCent(limit) : null,
    maxBuyConstraint: profitLimit <= roiLimit ? 'profit' : 'roi',
    maxBuyReason: limit < 0 ? 'No nonnegative purchase price meets both targets' : null,
    breakEvenSalePrice: requiredPrice(0), targetProfitSalePrice: requiredPrice(minimumProfit),
    targetRoiSalePrice: requiredPrice(landedCost * minimumRoi / 100),
    requiredSalePrice: requiredPrice(Math.max(minimumProfit, landedCost * minimumRoi / 100)),
    minimumProfit, minimumRoi, purchaseTaxRate };
}

export function calculateVolatility(prices) {
  const sorted = prices.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (sorted.length < 5) return { level: null, relativeIqr: null, sampleSize: sorted.length };
  const quantile = p => {
    const at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  };
  const relativeIqr = (quantile(0.75) - quantile(0.25)) / quantile(0.5);
  return { level: relativeIqr <= 0.2 ? 'Stable' : relativeIqr <= 0.5 ? 'Moderate' : 'Volatile', relativeIqr, sampleSize: sorted.length };
}

export function buildDecision({ economics, quality, match, sold90, activeCount, providerOk,
  pricingReliable, shippingUnknown = false, shippingEstimated = true, bulky = false, prices = [] }) {
  const gates = [];
  if (!['High', 'Exact identifier'].includes(match)) gates.push('Product match requires verification');
  if (!providerOk) gates.push('Provider incomplete or unavailable');
  if (!quality?.fresh) gates.push('Market data stale or timestamp unknown');
  if (quality?.sampleCapped) gates.push('Provider sample capped');
  if (!['High', 'Medium'].includes(quality?.level)) gates.push('Market data quality is insufficient');
  if (!pricingReliable) gates.push('Confirmed recent Sold prices are insufficient');
  if (!economics || economics.roi == null) gates.push('Profit or ROI cannot be calculated');
  if (shippingUnknown) gates.push('Shipping cost needs verification');
  const volatility = calculateVolatility(prices);
  const risks = [...gates];
  if (shippingEstimated && !shippingUnknown) risks.push('Shipping cost is estimated');
  if (bulky) risks.push('Bulky item: verify dimensions and carrier quote');
  if (volatility.level === 'Volatile') risks.push('Sold prices vary substantially');
  if (volatility.level == null) risks.push('Too few confirmed prices to assess volatility');
  const ratio = !gates.length && sold90 > 0 && Number.isFinite(activeCount) ? activeCount / sold90 : null;
  const saturation = ratio == null ? null : ratio > 3 ? 'Crowded' : ratio > 1 ? 'Balanced' : 'Low competition';
  if (saturation === 'Crowded') risks.push('Active samples exceed 90-day Sold by more than 3x');
  const risk = { level: gates.length || bulky || volatility.level === 'Volatile' ? 'High' : risks.length ? 'Medium' : 'Low', reasons: risks };
  let label = 'MAYBE', reasons = [...gates];
  if (!gates.length) {
    const { netProfit, roi, minimumProfit, minimumRoi } = economics;
    reasons = [`Estimated profit $${netProfit.toFixed(2)}; ROI ${roi.toFixed(1)}%`,
      `Targets: profit >= $${minimumProfit.toFixed(2)} and ROI >= ${minimumRoi}%`];
    if (netProfit <= 0 || roi < 20 || sold90 === 0) label = 'SKIP';
    else if (netProfit >= minimumProfit && roi >= minimumRoi && sold90 >= 3) label = 'BUY';
    else reasons.push('One or more purchase targets are not met');
  }
  return { schemaVersion: 1, economics: pricingReliable && providerOk && ['High', 'Exact identifier'].includes(match) ? economics : null,
    risk, volatility, saturation, daysToSell: null, capitalEfficiency: null,
    holdingPeriodReason: 'Market sale intervals do not establish an individual listing holding period',
    marketDataQuality: quality?.level || 'Low', gates,
    verdict: { label, reasons }, assumptions: ['USD; item sale price excludes buyer shipping',
      'Fees apply to item price plus buyer shipping; ads apply to item price',
      'Purchase tax defaults to 0%; marketplace tax on fees, tiered fees and returns are not modeled'] };
}
