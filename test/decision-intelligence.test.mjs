import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEconomics as calc, buildDecision, calculateVolatility } from '../lib/decision-intelligence.mjs';
import { snapshotFromAnalysis } from '../lib/monitoring.mjs';
import { testDb } from './db-helper.mjs';
import { readFileSync } from 'node:fs';
import { previousSnapshots, saveMonitoringResult, getTodaysOpportunities } from '../lib/scan-persistence.mjs';

const base = { salePrice: 100, cost: 30, sellerShipping: 10, feeRate: 10, promotedRate: 2, buyerShipping: 5, packaging: 1, fixedFee: 0.4 };
test('frontend controls have unique IDs', () => { const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]); assert.equal(new Set(ids).size, ids.length); });
const decision = overrides => buildDecision({ economics: calc(base), quality: { level: 'High', fresh: true, sampleCapped: false }, match: 'High', sold90: 10, activeCount: 5, providerOk: true, pricingReliable: true, shippingEstimated: false, prices: [95, 98, 100, 102, 105], ...overrides });
test('shipping collected once and fees apply to shipping', () => { assert.equal(calc(base).grossCollected, 105); assert.equal(calc(base).fees, 10.9); assert.ok(Math.abs(calc(base).netProfit - 51.1) < 1e-8); });
test('break even inverted with proportional fees and ads', () => { const e = calc(base); const profit = calc({ ...base, salePrice: e.breakEvenSalePrice }).netProfit; assert.ok(profit >= 0 && profit < 0.01); });
test('profit constraint dominates', () => { const e = calc({ ...base, minimumProfit: 60 }); assert.equal(e.maxBuyConstraint, 'profit'); assert.equal(e.maxBuyPrice, 21.1); });
test('ROI constraint dominates', () => { const e = calc({ ...base, minimumRoi: 200 }); assert.equal(e.maxBuyConstraint, 'roi'); assert.equal(e.maxBuyPrice, 27.03); });
test('max buy satisfies both constraints with purchase tax', () => { const e = calc({ ...base, purchaseTaxRate: 10 }); const actual = calc({ ...base, purchaseTaxRate: 10, cost: e.maxBuyPrice }); assert.ok(actual.netProfit >= 25 && actual.roi >= 40); });
test('one cent above max buy violates a target', () => { const e = calc(base); const actual = calc({ ...base, cost: e.maxBuyPrice + 0.01 }); assert.ok(actual.netProfit < 25 || actual.roi < 40); });
test('negative feasible purchase price is N/A not zero', () => { const e = calc({ ...base, salePrice: 5 }); assert.equal(e.maxBuyPrice, null); assert.ok(e.maxBuyReason); });
test('zero cost has profit but undefined ROI', () => { const e = calc({ ...base, cost: 0 }); assert.ok(e.netProfit > 0); assert.equal(e.roi, null); assert.equal(decision({ economics: e }).verdict.label, 'MAYBE'); });
test('100 percent total rates rejected', () => assert.equal(calc({ ...base, feeRate: 98 }), null));
test('negative inputs rejected', () => assert.equal(calc({ ...base, sellerShipping: -1 }), null));
test('missing cost is not zero', () => assert.equal(calc({ ...base, cost: null }), null));
test('nonfinite rates rejected', () => assert.equal(calc({ ...base, promotedRate: Infinity }), null));
test('required sale meets profit and ROI targets', () => { const e = calc(base); const actual = calc({ ...base, salePrice: e.requiredSalePrice }); assert.ok(actual.netProfit >= 25 && actual.roi >= 40); });
test('target ROI price meets ROI', () => assert.ok(calc({ ...base, salePrice: calc(base).targetRoiSalePrice }).roi >= 40));
test('target profit price meets profit', () => assert.ok(calc({ ...base, salePrice: calc(base).targetProfitSalePrice }).netProfit >= 25));
test('valid quality and targets can produce BUY', () => assert.equal(decision().verdict.label, 'BUY'));
for (const [name, override] of Object.entries({ stale: { quality: { level: 'High', fresh: false } }, capped: { quality: { level: 'High', fresh: true, sampleCapped: true } }, lowMatch: { match: 'Low' }, provider: { providerOk: false }, noConfirmedSold: { pricingReliable: false }, unknownShipping: { shippingUnknown: true } })) {
  test(`${name} suppresses BUY with explanation`, () => { const d = decision(override); assert.equal(d.verdict.label, 'MAYBE'); assert.ok(d.gates.length); assert.equal(d.risk.level, 'High'); });
}
test('negative profit with sound data means SKIP', () => assert.equal(decision({ economics: calc({ ...base, cost: 200 }) }).verdict.label, 'SKIP'));
test('estimated shipping is advisory and does not block BUY', () => { const d = decision({ shippingEstimated: true }); assert.equal(d.verdict.label, 'BUY'); assert.equal(d.risk.level, 'Medium'); });
test('bulky risk is explicit, not an automatic SKIP', () => { const d = decision({ bulky: true }); assert.equal(d.risk.level, 'High'); assert.equal(d.verdict.label, 'BUY'); });
test('individual holding period and capital efficiency not fabricated', () => { assert.equal(decision().daysToSell, null); assert.equal(decision().capitalEfficiency, null); });
test('IQR resists isolated huge outlier', () => assert.equal(calculateVolatility([99, 100, 100, 101, 10000]).level, 'Stable'));
test('volatility requires at least five confirmed prices', () => assert.equal(calculateVolatility([1, 2, 3, 4]).level, null));
test('broad dispersion is volatile', () => assert.equal(calculateVolatility([10, 20, 30, 100, 200]).level, 'Volatile'));
test('zero active avoids division by zero', () => assert.equal(decision({ activeCount: 0 }).saturation, 'Low competition'));
test('capped data cannot infer saturation', () => assert.equal(decision({ quality: { level: 'Low', fresh: true, sampleCapped: true } }).saturation, null));
test('expensive item and large shipping remain finite', () => assert.ok(Number.isFinite(calc({ ...base, cost: 500000, sellerShipping: 50000 }).breakEvenSalePrice)));
test('migration JSON column nullable and legacy snapshots remain readable', async () => {
  const DB = testDb();
  DB.raw.exec("INSERT INTO scan_runs(id,started_at,completed_at,trigger_type,status) VALUES('old','2026-01-01','2026-01-01','scheduled','completed'); INSERT INTO deal_snapshots(id,scan_run_id,deal_key,retailer,title,detected_at) VALUES('old','old','key','Home Depot','Test','2026-01-01')");
  const result = await previousSnapshots({ DB }, 'new');
  assert.equal(result.snapshots[0].decisionIntelligence, null);
});
test('decision JSON survives snapshot save and opportunity read', async () => {
  const DB = testDb(), now = new Date().toISOString();
  DB.raw.prepare("INSERT INTO scan_runs(id,started_at,trigger_type,status) VALUES(?,?,'scheduled','running')").run('run', now);
  const item = { deal: { retailer: 'Home Depot', title: 'Test' }, analysis: { decisionIntelligence: decision() } };
  const snapshot = snapshotFromAnalysis(item, 'run', now);
  const run = { id: 'run', completedAt: now, status: 'completed', totalDeals: 1, analyzedDeals: 1, buyCount: 0, maybeCount: 1, skipCount: 0, newCount: 1, priceDropCount: 0, errorCount: 0, providerSummary: [] };
  await saveMonitoringResult({ DB }, run, [snapshot], [{ id: 'event', scanRunId: 'run', dealKey: snapshot.dealKey, eventType: 'new_deal', retailer: 'Home Depot', title: 'Test', previousValue: null, currentValue: null, metadata: null, createdAt: now }]);
  assert.equal((await getTodaysOpportunities({ DB })).opportunities[0].snapshot.decisionIntelligence.schemaVersion, 1);
});
