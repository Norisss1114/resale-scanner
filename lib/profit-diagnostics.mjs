export const PROFIT_STATUSES = Object.freeze(['PROFITABLE', 'UNPROFITABLE', 'NO_SOLD_DATA', 'NO_ACTIVE_DATA', 'NO_MARKET_DATA', 'LOW_MATCH_CONFIDENCE', 'PROVIDER_ERROR', 'INSUFFICIENT_PRICE_DATA', 'ANALYSIS_ERROR']);

export function marketDataStatus({ soldOk, activeOk, soldMatches, activeMatches }) {
  if (!soldOk && !activeOk) return 'PROVIDER_ERROR';
  if (!soldOk || !activeOk) return 'PARTIAL';
  if (soldMatches === 0 && activeMatches === 0) return 'NO_MATCHES';
  if (soldMatches > 0 && activeMatches === 0) return 'SOLD_ONLY';
  if (soldMatches === 0 && activeMatches > 0) return 'ACTIVE_ONLY';
  return 'COMPLETE';
}

export function diagnoseProfit({ soldResult = {}, activeResult = {}, analysis = {}, matchingConfidence = {} }) {
  const soldMatches = soldResult.ok ? Number(soldResult.total) || 0 : null;
  const activeMatches = activeResult.ok ? Number(activeResult.total) || 0 : null;
  const marketStatus = marketDataStatus({ soldOk: soldResult.ok, activeOk: activeResult.ok, soldMatches, activeMatches });
  if (marketStatus === 'PROVIDER_ERROR' || marketStatus === 'PARTIAL') return result('PROVIDER_ERROR', 'eBay Sold or Active provider data is unavailable.', marketStatus, 'API ERROR');
  if (matchingConfidence.level === 'Low') return result('LOW_MATCH_CONFIDENCE', 'eBay results may exist, but the product match confidence is too low.', marketStatus, 'NO MATCH');
  if (marketStatus === 'NO_MATCHES') return result('NO_MARKET_DATA', 'No matching eBay sold or active listings were found.', marketStatus, 'NO DATA');
  if (marketStatus === 'ACTIVE_ONLY') return result('NO_SOLD_DATA', 'No matching sold listings were found in the last 90 days.', marketStatus, 'NO DATA');
  if (marketStatus === 'SOLD_ONLY') return result('NO_ACTIVE_DATA', 'Sold listings were found, but no matching active listings were found.', marketStatus, 'NO DATA');
  const price = finite(analysis.market?.targetSalePrice);
  const profit = finite(analysis.profit?.netProfit);
  const roi = finite(analysis.profit?.roi);
  const fees = finite(analysis.profit?.estimatedEbayFees);
  const shipping = finite(analysis.profit?.sellerShippingCost);
  if (price == null || price <= 0 || profit == null || roi == null || fees == null || shipping == null) return result('INSUFFICIENT_PRICE_DATA', 'Estimated sell price, fees, or shipping could not be calculated.', marketStatus, 'NO DATA');
  if (profit > 0) return result('PROFITABLE', `Estimated net profit is $${profit.toFixed(2)} after fees and shipping.`, marketStatus, null);
  return result('UNPROFITABLE', profit === 0 ? 'Estimated net profit is exactly $0.00 after fees and shipping.' : 'Estimated net profit is below $0 after fees and shipping.', marketStatus, null);
}

export function supportsDealScore(profitStatus) { return profitStatus === 'PROFITABLE' || profitStatus === 'UNPROFITABLE'; }

function result(profitStatus, profitReason, marketDataStatus, reasonBadge) { return { profitStatus, profitReason, marketDataStatus, reasonBadge }; }
function finite(value) { const number = Number(value); return value != null && value !== '' && Number.isFinite(number) ? number : null; }
