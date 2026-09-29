import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDealScore, calculateLocalScore, decideDealVerdict, filterDeals, matchingConfidenceForDeal, sortDeals } from '../lib/deal-utils.mjs';

const analysis = (profit, roi, sold90 = 20, sellThrough = 100) => ({
  profit: { netProfit: profit, roi },
  sold: { count90d: sold90 },
  market: { sellThrough90d: sellThrough }
});

test('Deal Score is clamped and classified', () => {
  const strong = calculateDealScore({ estimatedProfit: 200, roi: 300, sold90: 100, sellThrough: 400, discountPercent: 120, activeCount: 0 });
  const weak = calculateDealScore({ estimatedProfit: -20, roi: -10, sold90: 0, sellThrough: 0, discountPercent: 0, activeCount: 500 });
  assert.equal(strong.score, 100);
  assert.equal(strong.label, 'Strong opportunity');
  assert.equal(weak.score, 0);
  assert.equal(weak.label, 'Weak');
});

test('Deal filters use profit, ROI, and discount thresholds', () => {
  const items = [
    { status: 'OK', deal: { discountPercent: 50 }, analysis: analysis(40, 70) },
    { status: 'OK', deal: { discountPercent: 80 }, analysis: analysis(8, 200) },
    { status: 'ERROR', deal: { discountPercent: 90 }, analysis: analysis(100, 300) }
  ];
  assert.equal(filterDeals(items, { minimumProfit: 25, minimumRoi: 40, minimumDiscount: 10 }).length, 1);
});

test('Deal verdict does not buy on discount alone', () => {
  const score = { score: 90 };
  assert.equal(decideDealVerdict({ analysis: analysis(8, 200, 1), dealScore: score }).label, 'SKIP');
  assert.equal(decideDealVerdict({ analysis: analysis(62, 80, 32, 177), dealScore: score }).label, 'BUY');
});

test('Deal sorting supports score and market fields', () => {
  const items = [
    { dealScore: { score: 20 }, analysis: analysis(80, 50, 2) },
    { dealScore: { score: 90 }, analysis: analysis(20, 100, 30) }
  ];
  assert.equal(sortDeals(items, 'dealScore')[0].dealScore.score, 90);
  assert.equal(sortDeals(items, 'estimatedProfit')[0].analysis.profit.netProfit, 80);
  assert.equal(sortDeals(items, 'sold90')[0].analysis.sold.count90d, 30);
});

test('Retailer, source, verdict, and stock filters compose', () => {
  const items = [
    { status: 'OK', deal: { retailer: 'Walmart', sourceType: 'clearance', availability: 'in_stock', discountPercent: 50 }, verdict: { label: 'BUY' }, analysis: analysis(40, 70) },
    { status: 'OK', deal: { retailer: 'Target', sourceType: 'clearance', availability: 'unknown', discountPercent: 50 }, verdict: { label: 'MAYBE' }, analysis: analysis(40, 70) }
  ];
  assert.equal(filterDeals(items, { minimumProfit: 0, minimumRoi: 0, retailer: 'Walmart', sourceType: 'clearance', verdict: 'BUY', inStockOnly: true }).length, 1);
});

test('Matching confidence prioritizes identifiers and Low cannot become BUY', () => {
  assert.equal(matchingConfidenceForDeal({ upc: '885911325905' }).level, 'Exact identifier');
  assert.equal(matchingConfidenceForDeal({ brand: 'Brand', model: 'M1' }).level, 'High');
  assert.equal(matchingConfidenceForDeal({ title: 'Unidentified product' }).level, 'Low');
  assert.equal(decideDealVerdict({ analysis: analysis(80, 100, 30, 150), dealScore: { score: 90 }, matchingConfidence: 'Low' }).label, 'MAYBE');
});

test('Local filters require explicit evidence', () => {
  const items = [
    { status: 'OK', deal: { withinRadius: true, pickupAvailable: true, localAvailabilityStatus: 'confirmed' }, analysis: { profit: { netProfit: 40, roi: 80 } }, verdict: { label: 'BUY' } },
    { status: 'OK', deal: { withinRadius: true, pickupAvailable: true, localAvailabilityStatus: 'likely' }, analysis: { profit: { netProfit: 40, roi: 80 } }, verdict: { label: 'BUY' } }
  ];
  assert.equal(filterDeals(items, { confirmedOnly: true, minimumProfit: 0, minimumRoi: 0 }).length, 1);
  assert.equal(filterDeals(items, { withinRadiusOnly: true, pickupOnly: true, minimumProfit: 0, minimumRoi: 0 }).length, 2);
});

test('Local Score rewards nearby confirmed pickup without changing Deal Score', () => {
  const strong = calculateLocalScore({ distanceMiles: 1, radiusMiles: 15, pickupAvailable: true, localAvailabilityStatus: 'confirmed' });
  const weak = calculateLocalScore({ distanceMiles: 14, radiusMiles: 15, pickupAvailable: null, localAvailabilityStatus: 'unknown' });
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score <= 100 && weak.score >= 0);
});

test('Best Nearby Deal sorts by verdict, Deal Score, Local Score, then distance', () => {
  const items = [
    { verdict: { label: 'MAYBE' }, dealScore: { score: 99 }, localScore: { score: 99 }, deal: { storeDistanceMiles: 1 } },
    { verdict: { label: 'BUY' }, dealScore: { score: 70 }, localScore: { score: 50 }, deal: { storeDistanceMiles: 8 } },
    { verdict: { label: 'BUY' }, dealScore: { score: 70 }, localScore: { score: 80 }, deal: { storeDistanceMiles: 3 } }
  ];
  assert.equal(sortDeals(items, 'bestNearby')[0], items[2]);
  assert.equal(sortDeals(items, 'bestNearby')[2], items[0]);
});
