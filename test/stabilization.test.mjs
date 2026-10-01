import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './db-helper.mjs';
import { budgetHealth, budgetLimits, reserveProviderRequest, recordProviderResult, providerControls, scheduledAnalysisLimit } from '../lib/provider-budget.mjs';
import { createProviderTransport } from '../lib/provider-transport.mjs';
import { consumeLimit, issueSession, requireSession, sameOrigin, limitedJson, sessionCookie } from '../lib/access.mjs';
import { evaluateListingMatch, matchProfile, explicitVariantConflicts } from '../lib/product-matching.mjs';
import { marketConfidence, opportunityQuality } from '../lib/market-confidence.mjs';
import worker, { runDealScanService, runScheduledScan } from '../worker.js';
import { snapshotFromAnalysis } from '../lib/monitoring.mjs';
import { getTodaysOpportunities, saveMonitoringResult } from '../lib/scan-persistence.mjs';

const environment = () => ({ DB: testDb(), APP_ACCESS_PASSWORD: 'test-only-passphrase-long-enough' });
const time = Date.parse('2026-09-29T12:00:00Z');

test('global daily budget atomically rejects concurrent excess reservations', async () => {
  const env = { ...environment(), EBAY_PROVIDER_DAILY_REQUEST_LIMIT: 5 };
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => reserveProviderRequest(env, 'product', time)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 5);
  assert.equal((await budgetHealth(env, 'product', time)).requests, 5);
});
test('shared minute budget resets without resetting daily usage', async () => {
  const env = { ...environment(), EBAY_PROVIDER_MINUTE_REQUEST_LIMIT: 1 };
  await reserveProviderRequest(env, 'product', time);
  await assert.rejects(reserveProviderRequest(env, 'product', time), /budget/);
  await reserveProviderRequest(env, 'product', time + 60000);
  assert.equal((await budgetHealth(env, 'product', time)).daily_count, 2);
});
test('daily budget resets at UTC day boundary', async () => {
  const env = { ...environment(), EBAY_PROVIDER_DAILY_REQUEST_LIMIT: 1 };
  await reserveProviderRequest(env, 'product', time);
  await assert.rejects(reserveProviderRequest(env, 'product', time + 60000));
  await reserveProviderRequest(env, 'product', time + 86400000);
  assert.equal((await budgetHealth(env, 'product', time + 86400000)).daily_count, 1);
});
test('priority reserves capacity for Product above Manual above Scheduled', async () => {
  const env = { ...environment(), EBAY_PROVIDER_DAILY_REQUEST_LIMIT: 8 };
  for (let i = 0; i < 4; i++) await reserveProviderRequest(env, 'scheduled', time);
  await assert.rejects(reserveProviderRequest(env, 'scheduled', time));
  for (let i = 0; i < 2; i++) await reserveProviderRequest(env, 'manual', time);
  await assert.rejects(reserveProviderRequest(env, 'manual', time));
  for (let i = 0; i < 2; i++) await reserveProviderRequest(env, 'product', time);
  await assert.rejects(reserveProviderRequest(env, 'product', time));
});
test('unsafe budget config uses safe defaults', () => {
  assert.equal(budgetLimits({ EBAY_PROVIDER_DAILY_REQUEST_LIMIT: '-1' }).daily, 80);
  assert.equal(budgetLimits({ EBAY_PROVIDER_DAILY_REQUEST_LIMIT: 'Infinity' }).daily, 80);
});
test('scheduled candidate count degrades with reserved remaining budget', () => {
  assert.equal(scheduledAnalysisLimit(1), 0); assert.equal(scheduledAnalysisLimit(7), 3); assert.equal(scheduledAnalysisLimit(200), 8);
});
test('missing D1 fails closed before paid request', async () => {
  await assert.rejects(reserveProviderRequest({}), /D1/);
});
test('shared health records 429 and cooldown expiration', async () => {
  const env = environment();
  await reserveProviderRequest(env, 'product', time);
  await recordProviderResult(env, { status: 429, latency: 123, cooldownUntil: time + 120000 }, time);
  await assert.rejects(reserveProviderRequest(env, 'product', time + 119000));
  await reserveProviderRequest(env, 'product', time + 120000);
  const health = await budgetHealth(env, 'product', time + 120000);
  assert.equal(health.rate_limited, 1); assert.equal(health.latency_ms, 123); assert.equal(health.status, 'Healthy');
});
test('shared circuit opens after three failures', async () => {
  const env = environment();
  for (let i = 0; i < 3; i++) await recordProviderResult(env, { status: 503 }, time);
  await assert.rejects(reserveProviderRequest(env, 'product', time));
  const health = await budgetHealth(env, 'product', time);
  assert.equal(health.server_errors, 3); assert.equal(health.circuit_open, 1);
});
test('fresh shared cache avoids budget consumption across transports', async () => {
  const env = { ...environment(), EBAY_PROVIDER_DAILY_REQUEST_LIMIT: 1 };
  let calls = 0;
  const options = { interval: 0, fetcher: async () => { calls++; return Response.json({ results: [], count: 0 }); } };
  await createProviderTransport(options).request('https://example.test/sold', 'test-credential', providerControls(env, 'product'));
  await createProviderTransport(options).request('https://example.test/sold', 'test-credential', providerControls(env, 'scheduled'));
  const health = await budgetHealth(env);
  assert.equal(calls, 1); assert.equal(health.requests, 1); assert.equal(health.success, 1); assert.equal(health.cache_hits, 1);
  assert.ok(!JSON.stringify(env.DB.raw.prepare('SELECT * FROM provider_cache').all()).includes('test-credential'));
});
test('Product priority runs before queued Manual and Scheduled calls', async () => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const active = new Promise(resolve => { started = resolve; });
  const order = [];
  const transport = createProviderTransport({ interval: 0, fetcher: async url => {
    order.push(url); if (url === 'blocker') { started(); await gate; }
    return Response.json({ results: [] });
  } });
  const first = transport.request('blocker', 'key'); await active;
  const scheduled = transport.request('scheduled', 'key', { priority: 'scheduled' });
  const manual = transport.request('manual', 'key', { priority: 'manual' });
  const product = transport.request('product', 'key', { priority: 'product' });
  await new Promise(resolve => setTimeout(resolve, 20)); release();
  await Promise.all([first, scheduled, manual, product]);
  assert.deepEqual(order, ['blocker', 'product', 'manual', 'scheduled']);
});
test('provider response metadata and unexpected credential fields are not cached', async () => {
  let payload;
  const transport = createProviderTransport({ interval: 0, fetcher: async () => Response.json({ api_key: 'sensitive', results: [{ title: 'Product', authorization: 'sensitive' }] }) });
  await transport.request('url', 'key', { writeCache: async (_, data) => { payload = data; } });
  assert.ok(!JSON.stringify(payload).includes('sensitive'));
});
test('matching identifiers do not override an explicit variant conflict', () => {
  const result = evaluateListingMatch({ title: 'Ring Floodlight Cam Pro', gtin: '194252502000' }, { brand: 'Ring', title: 'Ring Floodlight Cam Plus', upc: '194252502000' });
  assert.equal(result.matched, false); assert.ok(result.matchEvidence.variantConflicts.length);
});
test('valid session cookie is signed HttpOnly and expires', async () => {
  const env = environment(); const token = await issueSession(env, env.APP_ACCESS_PASSWORD, time);
  const request = new Request('https://example.test/api/session', { headers: { cookie: `__Host-resale_session=${token}` } });
  await requireSession(request, env, time + 1000);
  await assert.rejects(requireSession(request, env, time + 13 * 3600000), /Unlock/);
  assert.match(sessionCookie(token), /HttpOnly; Secure; SameSite=Strict/);
});
test('wrong password and tampered sessions are rejected', async () => {
  const env = environment();
  await assert.rejects(issueSession(env, 'incorrect', time), /Incorrect/);
  const token = await issueSession(env, env.APP_ACCESS_PASSWORD, time);
  const request = new Request('https://example.test/api/session', { headers: { cookie: `__Host-resale_session=${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}` } });
  await assert.rejects(requireSession(request, env, time), /Invalid/);
});
test('endpoint authentication rejects unauthenticated paid request before fetch', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/analyze', { method: 'POST', headers: { origin: 'https://example.test' } }), environment());
  assert.equal(response.status, 401);
});
test('cross-origin request is rejected', () => {
  assert.throws(() => sameOrigin(new Request('https://example.test/api/analyze', { headers: { origin: 'https://attacker.test' } })), /Same-origin/);
});
test('login attempts share a durable limit', async () => {
  const env = environment();
  for (let i = 0; i < 5; i++) await consumeLimit(env, 'session-attempts', 5, 900000, time);
  await assert.rejects(consumeLimit(env, 'session-attempts', 5, 900000, time), /limit/);
});
test('oversized and non-object input rejected', async () => {
  await assert.rejects(limitedJson(new Request('https://example.test', { method: 'POST', body: '123456' }), 5), /large/);
  await assert.rejects(limitedJson(new Request('https://example.test', { method: 'POST', body: 'null' })), /JSON/);
});
test('input UPC or title digits alone never produce Exact identifier', () => {
  const product = { brand: 'Acme', model: 'AB123', upc: '194252502000' };
  const result = evaluateListingMatch({ title: 'Acme AB123 194252502000' }, product);
  assert.equal(result.matchMethod, 'brand_model'); assert.deepEqual(result.matchEvidence.identifiersMatched, []);
  assert.equal(matchProfile(product, [result]).level, 'High');
});
test('actual listing identifier produces explicit evidence', () => {
  const result = evaluateListingMatch({ title: 'Acme Tool', gtin: '194252502000' }, { upc: '194252502000' });
  assert.equal(result.matchMethod, 'upc_exact'); assert.deepEqual(result.matchEvidence.identifiersMatched, ['194252502000']);
});
for (const [left, right] of [['3rd gen', '4th gen'], ['128GB', '256GB'], ['2 pack', '4 pack'], ['55 inch', '65 inch'], ['12V', '20V'], ['left', 'right'], ["men's", "women's"], ['black', 'white']]) {
  test(`explicit variant conflict ${left} vs ${right}`, () => assert.ok(explicitVariantConflicts(left, right).length));
}
test('unknown dimensions are not guessed from model numbers', () => {
  assert.deepEqual(explicitVariantConflicts('Acme 128GB', 'Acme AB123'), []);
});
const market = () => ({ ok: true, fetched_at: new Date(time).toISOString(), listings: Array.from({ length: 12 }, () => ({ totalPrice: 100, soldDate: new Date(time - 86400000).toISOString() })) });
test('complete stable market earns High confidence', () => assert.equal(marketConfidence(market(), market(), { level: 'High' }, time).level, 'High'));
test('sample cap prevents high-confidence interpretation', () => assert.equal(marketConfidence({ ...market(), sampleCapped: true }, market(), { level: 'High' }, time).level, 'Low'));
test('stale market cannot support BUY', () => assert.equal(marketConfidence(market(), market(), { level: 'High' }, time + 3600000).fresh, false));
test('small sample or low match lowers market confidence', () => {
  assert.equal(marketConfidence({ ...market(), listings: [] }, market(), { level: 'High' }, time).level, 'Low');
  assert.equal(marketConfidence(market(), market(), { level: 'Low' }, time).level, 'Low');
});
test('capped and stale opportunities cannot be Strong', () => {
  const snapshot = { profitStatus: 'PROFITABLE', estimatedProfit: 50, roi: 100, matchingConfidence: 'High', marketConfidence: 'High', marketFetchedAt: new Date(time).toISOString(), sampleCapped: false };
  assert.equal(opportunityQuality(snapshot, time), true);
  assert.equal(opportunityQuality({ ...snapshot, sampleCapped: true }, time), false);
  assert.equal(opportunityQuality(snapshot, time + 3600000), false);
});
test('migrated D1 stores null profit and returns N/A-compatible opportunities', async () => {
  const env = environment(); const now = new Date().toISOString();
  env.DB.raw.prepare("INSERT INTO scan_runs(id,started_at,trigger_type,status) VALUES ('r',?,'manual','running')").run(now);
  const snapshot = snapshotFromAnalysis({ deal: { retailer: 'Walmart', title: 'Tool', sku: '1' }, profitStatus: 'PROVIDER_ERROR' }, 'r', now);
  await saveMonitoringResult(env, { id: 'r', completedAt: now, status: 'partial', totalDeals: 1, analyzedDeals: 0, buyCount: 0, maybeCount: 1, skipCount: 0, newCount: 1, priceDropCount: 0, errorCount: 1, providerSummary: [] }, [snapshot], [{ id: 'e', scanRunId: 'r', dealKey: snapshot.dealKey, eventType: 'new_deal', retailer: 'Walmart', title: 'Tool', previousValue: null, currentValue: null, createdAt: now }]);
  const result = await getTodaysOpportunities(env);
  assert.equal(result.opportunities[0].snapshot.estimatedProfit, null);
  assert.equal(result.opportunities[0].snapshot.roi, null);
  assert.equal(result.summary.strong, 0);
  assert.equal(result.summary.potentialProfit, null);
});

test('scheduled service uses real D1, degrades at budget exhaustion, and avoids duplicate new events', async () => {
  const env = { ...environment(), EBAY_SOLD_API_URL: 'https://scheduled-fixture.test/scrape', EBAY_SOLD_API_KEY: 'scheduled-fixture-key', EBAY_PROVIDER_DAILY_REQUEST_LIMIT: 4 };
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const query = new URL(url).searchParams.get('keyword');
    return Response.json({ results: Array.from({ length: 3 }, (_, index) => ({ itemId: String(index), title: query, totalPrice: 100 + index, endedAt: new Date(Date.now() - 86400000).toISOString() })) });
  };
  try {
    const scanService = (e, body, options) => runDealScanService(e, { ...body, source: 'mock', location: {} }, options);
    const first = await runScheduledScan(env, { scanService, scheduledTime: Date.now() });
    const second = await runScheduledScan(env, { scanService, scheduledTime: Date.now() + 3600000 });
    assert.equal(first.snapshots, 6); assert.equal(calls, 2);
    assert.equal(first.status, 'partial'); assert.equal(second.status, 'skipped');
    const row = env.DB.raw.prepare('SELECT * FROM scan_runs WHERE id = ?').get(second.runId);
    assert.equal(row.new_count, 0); assert.equal(row.analyzed_deals, 0);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM deal_snapshots').get().n, 12);
  } finally { globalThis.fetch = original; }
});
