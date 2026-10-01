import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imageDimensions, validateImageFile, prepareImage } from '../public/image-input.js';
import { calculateEconomics, buildDecision } from '../lib/decision-intelligence.mjs';
import { budgetHealth, quotaLimits, reserveProviderRequest, recordProviderResult, providerControls } from '../lib/provider-budget.mjs';
import { createProviderTransport } from '../lib/provider-transport.mjs';
import { testDb } from './db-helper.mjs';
import worker from '../worker.js';
import { issueSession } from '../lib/access.mjs';

const now = Date.parse('2026-09-30T12:00:00Z');
const env = () => ({ DB: testDb(), EBAY_PROVIDER_QUOTA_RESET_AT: '2026-10-15T00:00:00Z' });
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
test('exhausted Product Scan stops before OpenAI or eBay expense', async () => {
  const e = { DB: testDb(), APP_ACCESS_PASSWORD: 'test-only-long-password-265', OPENAI_API_KEY: 'fixture', EBAY_SOLD_API_URL: 'https://fixture.test/scrape', EBAY_SOLD_API_KEY: 'fixture' };
  await recordProviderResult(e, { status: 402 });
  const token = await issueSession(e, e.APP_ACCESS_PASSWORD), original = globalThis.fetch;
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('unexpected paid request'); };
  try {
    const response = await worker.fetch(new Request('https://fixture.test/api/analyze', { method: 'POST', headers: { origin: 'https://fixture.test', cookie: `__Host-resale_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ productImage: 'data:image/png;base64,AAAA' }) }), e);
    assert.equal(response.status, 402); assert.equal((await response.json()).providerHealth.remaining, 0); assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('camera uses rear-camera capture hint', () => assert.match(html.match(/<input[^>]+id="productImage"[^>]*>/)[0], /capture="environment"/));
test('photo library uses native picker without capture', () => { const input = html.match(/<input[^>]+id="barcodeImage"[^>]*>/)[0]; assert.match(input, /accept="image\/\*"/); assert.doesNotMatch(input, /capture/); });
test('shared preview has replace remove and selected state', () => { for (const id of ['preview', 'replaceImage', 'removeImage', 'selectedImageState']) assert.ok(html.includes(`id="${id}"`)); });
for (const extension of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) {
  test(`image selection accepts ${extension}`, () => assert.doesNotThrow(() => validateImageFile({ name: `photo.${extension}`, size: 100, type: '' })));
}
test('nonimage selection rejected', () => assert.throws(() => validateImageFile({ name: 'file.txt', type: 'text/plain', size: 10 })));
test('empty image rejected', () => assert.throws(() => validateImageFile({ name: 'file.png', size: 0 })));
test('oversized image rejected', () => assert.throws(() => validateImageFile({ name: 'file.jpg', size: 31 * 1024 * 1024 })));
test('landscape compression preserves aspect', () => assert.deepEqual(imageDimensions(4032, 3024), { width: 2048, height: 1536 }));
test('portrait compression preserves aspect', () => assert.deepEqual(imageDimensions(3024, 4032), { width: 1536, height: 2048 }));
test('small images not enlarged', () => assert.deepEqual(imageDimensions(100, 50), { width: 100, height: 50 }));
test('invalid image dimensions rejected', () => assert.throws(() => imageDimensions(0, 0)));
test('native decode failure gives explicit HEIC fallback', async () => {
  const original = globalThis.Image;
  globalThis.Image = class { async decode() { throw new Error('unsupported'); } };
  try { await assert.rejects(prepareImage(new File(['x'], 'a.heic')), /HEIC\/HEIF.*JPEG/); }
  finally { globalThis.Image = original; }
});
const economics = extra => calculateEconomics({ salePrice: 19.75, cost: 4, sellerShipping: 1, ...extra });
test('impossible target distinguished from missing data', () => assert.equal(economics().maxBuyState, 'TARGET_IMPOSSIBLE'));
test('feasible buy price has VALUE state', () => assert.equal(economics({ salePrice: 100 }).maxBuyState, 'VALUE'));
test('hidden unreliable economics has insufficient state', () => assert.equal(buildDecision({ economics: economics(), quality: {}, pricingReliable: false }).maxBuyState, 'INSUFFICIENT_DATA'));
test('high ROI does not override absolute profit target', () => { const d = buildDecision({ economics: economics(), quality: { level: 'High', fresh: true }, match: 'High', providerOk: true, pricingReliable: true, sold90: 13, activeCount: 53, prices: [28, 28, 28, 28, 28] }); assert.equal(d.verdict.label, 'MAYBE'); assert.ok(d.risk.reasons.some(x => x.includes('3x'))); });
test('cycle defaults 3000 with Product reserve', () => { assert.equal(quotaLimits().usable, 3000); assert.equal(quotaLimits({}, 'manual').usable, 1200); assert.equal(quotaLimits({}, 'scheduled').usable, 450); });
test('reset date requires explicit timezone', () => assert.equal(quotaLimits({ EBAY_PROVIDER_QUOTA_RESET_AT: '2026-10-15' }).invalid, true));
test('402 persists stop with zero remaining', async () => { const e = env(); await recordProviderResult(e, { status: 402 }, now); const h = await budgetHealth(e, 'product', now); assert.equal(h.status, 'Quota exhausted'); assert.equal(h.remaining, 0); assert.equal(h.quota.resetAt, '2026-10-15T00:00:00.000Z'); await assert.rejects(reserveProviderRequest(e, 'product', now), /quota exhausted/); });
test('429 does not latch billing quota', async () => { const e = env(); await recordProviderResult(e, { status: 429, cooldownUntil: now + 1000 }, now); assert.equal((await budgetHealth(e, 'product', now)).status, 'Cooling Down'); assert.equal((await budgetHealth(e, 'product', now + 1001)).status, 'Healthy'); });
test('cycle usage does not reset on calendar month', async () => { const e = env(); await reserveProviderRequest(e, 'product', now); assert.equal((await budgetHealth(e, 'product', Date.parse('2026-10-01T00:00:00Z'))).quota.used, 1); });
test('expired billing date fails closed until confirmation', async () => { const e = env(); await reserveProviderRequest(e, 'product', now); const later = Date.parse('2026-10-16T00:00:00Z'); await assert.rejects(reserveProviderRequest(e, 'product', later), /quota exhausted/); e.EBAY_PROVIDER_QUOTA_RESET_AT = '2026-11-15T00:00:00Z'; await reserveProviderRequest(e, 'product', later); assert.equal((await budgetHealth(e, 'product', later)).quota.used, 1); });
test('editing future reset cannot refund or clear 402', async () => { const e = env(); await reserveProviderRequest(e, 'product', now); await recordProviderResult(e, { status: 402 }, now); e.EBAY_PROVIDER_QUOTA_RESET_AT = '2026-11-15T00:00:00Z'; const h = await budgetHealth(e, 'product', now); assert.equal(h.quota.used, 1); assert.equal(h.remaining, 0); assert.equal(h.quota.resetAt, '2026-10-15T00:00:00.000Z'); });
test('cycle admission is atomic under concurrent requests', async () => { const e = { ...env(), EBAY_PROVIDER_QUOTA_LIMIT: 2 }; const r = await Promise.allSettled(Array.from({ length: 10 }, () => reserveProviderRequest(e, 'product', now))); assert.equal(r.filter(x => x.status === 'fulfilled').length, 2); });
test('scheduled and manual cannot consume Product reserve', async () => { const e = { ...env(), EBAY_PROVIDER_QUOTA_LIMIT: 20 }; for (let i = 0; i < 3; i++) await reserveProviderRequest(e, 'scheduled', now); await assert.rejects(reserveProviderRequest(e, 'scheduled', now)); for (let i = 0; i < 5; i++) await reserveProviderRequest(e, 'manual', now); await assert.rejects(reserveProviderRequest(e, 'manual', now)); assert.equal((await budgetHealth(e, 'product', now)).quota.remaining, 12); });
test('402 no retry and subsequent standalone request stopped', async () => { let calls = 0; const client = createProviderTransport({ sleep: async () => {}, fetcher: async () => { calls++; return new Response('private billing data', { status: 402 }); } }); await assert.rejects(client.request('a', 'key'), /402/); await assert.rejects(client.request('b', 'key'), /quota exhausted/); assert.equal(calls, 1); });
test('402 stop shared between separate transport isolates', async () => { const e = { DB: testDb() }; let calls = 0; const options = { sleep: async () => {}, fetcher: async () => { calls++; return new Response('', { status: 402 }); } }; await assert.rejects(createProviderTransport(options).request('a', 'key', providerControls(e, 'product')), /402/); await assert.rejects(createProviderTransport(options).request('b', 'key', providerControls(e, 'scheduled')), /quota exhausted/); assert.equal(calls, 1); });
