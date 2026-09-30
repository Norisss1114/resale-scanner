import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots, dedupeEvents, notificationEligible, retentionCutoff, scanRunStatus, sortOpportunities, stableDealKey } from '../lib/monitoring.mjs';
import { acquireScheduledRun, cleanupMonitoring, getLatestScan } from '../lib/scan-persistence.mjs';
import { runScheduledScan } from '../worker.js';

const snapshot = (overrides = {}) => ({ scanRunId: 'run-new', dealKey: 'sku:walmart:abc', retailer: 'Walmart', title: 'Product', salePrice: 50, estimatedProfit: 30, roi: 50, dealScore: 70, localScore: 40, decision: 'MAYBE', matchingConfidence: 'High', localAvailabilityStatus: 'unknown', detectedAt: '2026-09-30T12:00:00.000Z', ...overrides });

test('stable deal key follows identifier, SKU, URL, model, and title priority', () => {
  assert.equal(stableDealKey({ retailer: 'Walmart', upc: '012345678905', sku: 'x' }), 'id:012345678905');
  assert.equal(stableDealKey({ retailer: 'Walmart', sku: 'ABC 1' }), 'sku:walmart:abc-1');
  assert.equal(stableDealKey({ retailer: 'Target', productUrl: 'https://www.target.com/p/item?ref=x' }), 'url:target:www.target.com/p/item');
  assert.equal(stableDealKey({ retailer: 'Target', brand: 'Ninja', model: 'BL610' }), 'model:target:ninja:bl610');
  assert.equal(stableDealKey({ retailer: 'Target', title: 'Ninja Blender' }), 'title:target:ninja-blender');
});

test('comparison detects a new deal', () => {
  assert.deepEqual(compareSnapshots([snapshot()], []).map(item => item.eventType), ['new_deal']);
});

test('comparison detects price drop by dollars or percent', () => {
  const events = compareSnapshots([snapshot({ salePrice: 94 })], [snapshot({ salePrice: 100 })]);
  assert.equal(events.find(item => item.eventType === 'price_drop').metadata.amount, 6);
});

test('comparison detects became BUY and score increase', () => {
  const events = compareSnapshots([snapshot({ decision: 'BUY', dealScore: 82 })], [snapshot({ decision: 'MAYBE', dealScore: 70 })]);
  assert.ok(events.some(item => item.eventType === 'became_buy'));
  assert.ok(events.some(item => item.eventType === 'score_increase'));
});

test('historical missing deal is marked returned instead of new', () => {
  assert.equal(compareSnapshots([snapshot()], [], new Set(['sku:walmart:abc']))[0].eventType, 'returned');
});

test('event dedupe keeps one event per run, deal, and type', () => {
  const duplicate = { scanRunId: 'r', dealKey: 'd', eventType: 'price_drop', currentValue: 40 };
  assert.equal(dedupeEvents([duplicate, { ...duplicate, currentValue: 35 }]).length, 1);
});

test('opportunity sorting prioritizes became BUY before raw score', () => {
  const highScore = { snapshot: snapshot({ dealScore: 99 }), events: [{ eventType: 'score_increase' }] };
  const becameBuy = { snapshot: snapshot({ dealScore: 70 }), events: [{ eventType: 'became_buy' }] };
  assert.equal(sortOpportunities([highScore, becameBuy])[0], becameBuy);
});

test('notification eligibility covers became BUY, new strong, and price drop BUY', () => {
  assert.equal(notificationEligible([{ eventType: 'became_buy' }], snapshot()), true);
  assert.equal(notificationEligible([{ eventType: 'new_deal' }], snapshot({ dealScore: 85, estimatedProfit: 30, roi: 50 })), true);
  assert.equal(notificationEligible([{ eventType: 'price_drop' }], snapshot({ decision: 'BUY' })), true);
  assert.equal(notificationEligible([{ eventType: 'score_increase' }], snapshot()), false);
});

test('scan status distinguishes completed, partial, and failed', () => {
  assert.equal(scanRunStatus({ providerStatuses: [{ status: 'ok' }], analyzed: 2, errors: 0 }), 'completed');
  assert.equal(scanRunStatus({ providerStatuses: [{ status: 'unavailable' }, { status: 'ok' }], analyzed: 1, errors: 0 }), 'partial');
  assert.equal(scanRunStatus({ providerStatuses: [{ status: 'error' }], analyzed: 0, errors: 1 }), 'failed');
});

test('retention cutoff is 90 days and cleanup issues three deletes', async () => {
  const batches = [];
  const db = fakeDb({ batch: statements => { batches.push(statements); return []; } });
  const now = new Date('2026-09-30T12:00:00Z');
  assert.equal(retentionCutoff(now), '2026-07-02T12:00:00.000Z');
  const result = await cleanupMonitoring({ DB: db }, now);
  assert.equal(result.deleted, true);
  assert.equal(batches[0].length, 3);
});

test('scheduled scan uses shared service and persists a completed run', async () => {
  let sharedCalls = 0;
  const db = fakeDb();
  const result = await runScheduledScan({ DB: db, EBAY_SOLD_API_URL: 'x', EBAY_SOLD_API_KEY: 'y' }, {
    scheduledTime: Date.parse('2026-09-30T12:00:00Z'),
    scanService: async () => {
      sharedCalls += 1;
      const deal = { id: 'deal-1', retailer: 'Walmart', title: 'Deal', sku: 'sku1', salePrice: 20, regularPrice: 50, discountPercent: 60, availabilityType: 'online', localAvailabilityStatus: 'unknown' };
      const analyzed = { deal, status: 'OK', analysis: { market: {}, profit: { netProfit: 30, roi: 100 }, sold: {}, active: {} }, dealScore: { score: 75 }, localScore: { score: 0 }, verdict: { label: 'BUY' }, matchingConfidence: { level: 'High' } };
      return { providers: [{ retailer: 'Walmart', status: 'ok' }], counts: { fetched: 1, analyzed: 1, errors: 0, buy: 1, maybe: 0, skip: 0 }, allDeals: [deal], analyzedItems: [analyzed] };
    }
  });
  assert.equal(sharedCalls, 1);
  assert.equal(result.status, 'completed');
  assert.ok(db.runs.some(sql => sql.startsWith('UPDATE scan_runs')));
});

test('D1 unavailable returns fallback and prevents scheduled execution', async () => {
  assert.deepEqual(await acquireScheduledRun({}), { acquired: false, reason: 'D1 unavailable' });
  assert.equal((await getLatestScan({})).available, false);
  let called = false;
  const result = await runScheduledScan({}, { scanService: async () => { called = true; } });
  assert.equal(result.status, 'skipped');
  assert.equal(called, false);
});

test('scheduled lock rejects a duplicate UTC hour atomically', async () => {
  const db = fakeDb();
  db.prepare = () => ({ bind() { return this; }, async run() { return { meta: { changes: 0 } }; } });
  const lock = await acquireScheduledRun({ DB: db }, new Date('2026-09-30T12:42:00Z'));
  assert.deepEqual(lock, { acquired: false, reason: 'duplicate_window', runId: 'scheduled_2026-09-30T12:00:00.000Z' });
});

function fakeDb(overrides = {}) {
  const db = {
    runs: [],
    prepare(sql) {
      const statement = {
        args: [], bind(...args) { this.args = args; return this; },
        async first() { return null; }, async all() { return { results: [] }; },
        async run() { db.runs.push(sql); return { success: true }; }
      };
      return statement;
    },
    async batch(statements) { db.runs.push(...statements.map(() => 'BATCH')); return []; },
    ...overrides
  };
  return db;
}
