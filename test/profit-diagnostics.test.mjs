import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseProfit, marketDataStatus, supportsDealScore } from '../lib/profit-diagnostics.mjs';
import { isStrong } from '../lib/monitoring.mjs';

const analysis = overrides => ({ market: { targetSalePrice: 100 }, profit: { netProfit: 20, roi: 50, estimatedEbayFees: 14, sellerShippingCost: 10 }, ...overrides });
const result = (soldTotal, activeTotal, overrides = {}) => diagnoseProfit({ soldResult: { ok: true, total: soldTotal }, activeResult: { ok: true, total: activeTotal }, analysis: analysis(overrides), matchingConfidence: { level: 'High' } });

test('no sold data is distinct from no active data', () => {
  assert.equal(result(0, 4).profitStatus, 'NO_SOLD_DATA');
  assert.equal(result(4, 0).profitStatus, 'NO_ACTIVE_DATA');
});

test('provider error is not treated as zero listings', () => {
  const diagnosis = diagnoseProfit({ soldResult: { ok: false }, activeResult: { ok: true, total: 3 }, analysis: analysis(), matchingConfidence: { level: 'High' } });
  assert.equal(diagnosis.profitStatus, 'PROVIDER_ERROR');
  assert.equal(diagnosis.marketDataStatus, 'PARTIAL');
});

test('low matching confidence blocks profit classification', () => {
  const diagnosis = diagnoseProfit({ soldResult: { ok: true, total: 3 }, activeResult: { ok: true, total: 2 }, analysis: analysis(), matchingConfidence: { level: 'Low' } });
  assert.equal(diagnosis.profitStatus, 'LOW_MATCH_CONFIDENCE');
  assert.equal(diagnosis.reasonBadge, 'NO MATCH');
});

test('missing calculated profit is insufficient price data', () => {
  const diagnosis = result(3, 2, { profit: { netProfit: null, roi: null, estimatedEbayFees: null, sellerShippingCost: 10 } });
  assert.equal(diagnosis.profitStatus, 'INSUFFICIENT_PRICE_DATA');
  assert.equal(supportsDealScore(diagnosis.profitStatus), false);
});

test('true zero profit remains a calculated unprofitable result', () => {
  const diagnosis = result(3, 2, { profit: { netProfit: 0, roi: 0, estimatedEbayFees: 14, sellerShippingCost: 10 } });
  assert.equal(diagnosis.profitStatus, 'UNPROFITABLE');
  assert.match(diagnosis.profitReason, /exactly \$0\.00/);
  assert.equal(supportsDealScore(diagnosis.profitStatus), true);
});

test('market data status covers complete, sold only, active only, no matches, and provider error', () => {
  assert.equal(marketDataStatus({ soldOk: true, activeOk: true, soldMatches: 2, activeMatches: 2 }), 'COMPLETE');
  assert.equal(marketDataStatus({ soldOk: true, activeOk: true, soldMatches: 2, activeMatches: 0 }), 'SOLD_ONLY');
  assert.equal(marketDataStatus({ soldOk: true, activeOk: true, soldMatches: 0, activeMatches: 2 }), 'ACTIVE_ONLY');
  assert.equal(marketDataStatus({ soldOk: true, activeOk: true, soldMatches: 0, activeMatches: 0 }), 'NO_MATCHES');
  assert.equal(marketDataStatus({ soldOk: false, activeOk: false, soldMatches: null, activeMatches: null }), 'PROVIDER_ERROR');
});

test('Strong opportunity excludes NO DATA even with legacy numeric metrics', () => {
  assert.equal(isStrong({ profitStatus: 'NO_MARKET_DATA', dealScore: 95, estimatedProfit: 50, roi: 100, matchingConfidence: 'High' }), false);
  assert.equal(isStrong({ profitStatus: 'PROFITABLE', dealScore: 95, estimatedProfit: 50, roi: 100, matchingConfidence: 'High' }), true);
});
