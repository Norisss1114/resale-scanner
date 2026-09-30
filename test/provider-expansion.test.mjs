import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { exactPrice, normalizePublicProduct, parseTargetEmbeddedState, parseTargetHtmlCards,
  parseTargetJsonLd, parseWalmartEmbeddedState, parseWalmartHtmlCards, parseKohlsEmbeddedState,
  parseKohlsHtmlCards, parseKohlsJsonLd, runParserCandidates } from '../lib/public-retail-parsers.mjs';
import { TargetDealProvider, WalmartDealProvider, KohlsDealProvider, clearRetailerCacheForTests,
  dedupeDeals, parseTargetDeals, parseKohlsDeals, RETAILER_PROVIDERS } from '../lib/retailer-providers.mjs';
import { rankCandidates, candidatePreScore, candidateRequestCapacity } from '../lib/candidate-ranking.mjs';
import { budgetLimits } from '../lib/provider-budget.mjs';

const script = (data, type = 'application/json') => `<script type="${type}">${JSON.stringify(data)}</script>`;
const product = { name: 'Brand Drill', sku: '123', url: '/p/drill/-/A-123', brand: 'Brand', regularPrice: 100, offers: { price: 50, priceCurrency: 'USD' } };
const targetState = { tcin: '123', item: { product_description: { title: 'Brand Drill' }, primary_brand: { name: 'Brand' }, enrichment: { buy_url: '/p/drill/-/A-123', images: { primary_image_url: 'https://image.test/a.png' } } }, price: { current_retail: 50, reg_retail: 100 } };
const targetCard = '<div data-test="product-card" data-tcin="123"><a data-test="product-title" href="/p/drill/-/A-123">Brand Drill</a><span data-test="current-price">$50.00</span><s>$100.00</s><span>Clearance</span></div>';
const kohls = { productId: '123', productTitle: 'Mixer', productURL: '/product/prd-123/mixer.jsp', salePrice: 50, regularPrice: 100, brand: 'Brand' };

test('Target embedded public state extracts price and TCIN', () => { const d = parseTargetEmbeddedState(script({ products: [targetState] }))[0]; assert.equal(d.salePrice, 50); assert.equal(d.sku, '123'); assert.equal(d.parserSource, 'embedded_state'); });
test('Target HTML card extracts explicit reference price', () => { const d = parseTargetHtmlCards(targetCard)[0]; assert.equal(d.discountPercent, 50); assert.equal(d.parserSource, 'html_card'); });
test('clearance HTML without reference keeps null discount', () => { const d = parseTargetHtmlCards(targetCard.replace('<s>$100.00</s>', ''))[0]; assert.equal(d.dealType, 'clearance'); assert.equal(d.discountPercent, null); });
test('Target JSON-LD fallback extracts nested ItemList Product', () => assert.equal(parseTargetJsonLd(script({ '@type': 'ItemList', itemListElement: [{ item: { ...product, '@type': 'Product' } }] }, 'application/ld+json')).length, 1));
test('Target missing price rejected', () => assert.equal(normalizePublicProduct({ ...product, offers: {} }, 'Target', 'json_ld'), null));
test('Target clearance without original price has null discount', () => { const d = normalizePublicProduct({ ...product, regularPrice: null, clearance: true }, 'Target', 'json_ld'); assert.equal(d.discountPercent, null); assert.equal(d.dealType, 'clearance'); });
test('Target regular product without clearance rejected', () => assert.equal(normalizePublicProduct({ ...product, regularPrice: null }, 'Target', 'json_ld'), null));
test('Target multiple parsers dedupe same product', () => assert.equal(parseTargetDeals(script({ products: [targetState] }) + targetCard).length, 1));
test('Target malformed embedded state still tries cards', () => assert.equal(parseTargetDeals('<script type="application/json">{broken</script>' + targetCard).length, 1));
test('HTML container with two product URLs is rejected', () => assert.equal(parseTargetHtmlCards(targetCard.replace('</div>', '<a href="/p/another/-/A-2">Another</a></div>')).length, 0));
test('Target missing title rejected', () => assert.equal(normalizePublicProduct({ ...product, name: '' }, 'Target', 'json_ld'), null));
for (const url of ['javascript:alert(1)', 'https://evil.test/p/a', '/c/clearance', 'https://www.target.com@evil.test/p/a']) {
  test(`unsafe/nonproduct URL rejected: ${url}`, () => assert.equal(normalizePublicProduct({ ...product, url }, 'Target', 'json_ld'), null));
}
test('Walmart relocated embedded state fallback', () => { const d = parseWalmartEmbeddedState(script({ relocated: [{ __typename: 'Product', id: '1', name: 'Tool', priceInfo: { linePrice: '$20', wasPrice: '$40' }, canonicalUrl: '/ip/tool/1' }] }))[0]; assert.equal(d.salePrice, 20); });
test('Walmart HTML fallback uses item ID', () => assert.equal(parseWalmartHtmlCards('<div data-item-id="1"><a href="/ip/tool/1">Tool</a><span data-testid="price">$20</span><s>$40</s></div>')[0].sku, '1'));
test('malformed HTML does not manufacture deals', () => assert.deepEqual(parseWalmartHtmlCards('<div><span>$19.99<script>'), []));
for (const status of [403, 429]) test(`Walmart HTTP ${status} unavailable without retry`, async () => { clearRetailerCacheForTests(); let calls = 0; const p = new WalmartDealProvider({ fetcher: async () => { calls++; return new Response('blocked', { status }); } }); const r = await p.listDeals(); assert.equal(r.status, 'unavailable'); assert.equal(r.httpStatus, status); await p.listDeals(); assert.equal(calls, 1); });
test('HTTP200 anti-bot document unavailable', async () => { clearRetailerCacheForTests(); const r = await new WalmartDealProvider({ fetcher: async () => new Response('<title>Robot or human</title>') }).listDeals(); assert.equal(r.status, 'unavailable'); assert.equal(r.failureType, 'blocked_or_empty'); });
test('Target client-only document unavailable not empty', async () => { clearRetailerCacheForTests(); const r = await new TargetDealProvider({ fetcher: async () => new Response('<html><div id="root"></div></html>') }).listDeals(); assert.equal(r.status, 'unavailable'); assert.equal(r.httpStatus, 200); });
test('Kohls embedded adapter preserves sale reference discount', () => { const d = parseKohlsEmbeddedState(script({ products: [kohls] }))[0]; assert.equal(d.retailer, "Kohl's"); assert.equal(d.regularPrice, 100); assert.equal(d.salePrice, 50); assert.equal(d.discountPercent, 50); });
test('Kohls HTML card adapter', () => assert.equal(parseKohlsHtmlCards(targetCard.replace('/p/drill/-/A-123', '/product/prd-123/drill.jsp')).length, 1));
test('Kohls JSON-LD adapter', () => assert.equal(parseKohlsJsonLd(script({ ...product, '@type': 'Product', url: '/product/prd-123/drill.jsp' }, 'application/ld+json')).length, 1));
test('Kohls coupon and member prices never replace regular purchase price', () => { const d = parseKohlsEmbeddedState(script({ products: [{ ...kohls, couponPrice: 30, couponRequired: true, memberPrice: 25, memberRequired: true }] }))[0]; assert.equal(d.salePrice, 50); assert.equal(d.couponPrice, 30); assert.equal(d.memberPrice, 25); });
test('Kohls conditional-only price rejected', () => assert.equal(parseKohlsEmbeddedState(script({ products: [{ ...kohls, memberOnly: true }] })).length, 0));
test('Kohls duplicate products removed', () => assert.equal(parseKohlsDeals(script({ products: [kohls, kohls] })).length, 1));
test('Kohls blocked provider reports unavailable', async () => { clearRetailerCacheForTests(); assert.equal((await new KohlsDealProvider({ fetcher: async () => new Response('blocked', { status: 403 }) }).listDeals()).status, 'unavailable'); });
test('price range is not a single price', () => { assert.equal(exactPrice('$20 - $40'), null); assert.equal(exactPrice('From $20'), null); assert.equal(exactPrice(''), null); assert.equal(exactPrice('Sale $20.00'), 20); });
test('AggregateOffer high price never becomes reference price', () => assert.equal(normalizePublicProduct({ ...product, offers: { '@type': 'AggregateOffer', lowPrice: 20, highPrice: 40 } }, 'Target', 'json_ld'), null));
test('nonUSD offer rejected', () => assert.equal(normalizePublicProduct({ ...product, offers: { price: 50, priceCurrency: 'EUR' } }, 'Target', 'json_ld'), null));
test('unavailable stock does not match available substring', () => assert.equal(normalizePublicProduct({ ...product, availability: 'unavailable' }, 'Target', 'json_ld').availability, 'out_of_stock'));
test('parser exception isolated from next candidate', () => { const r = runParserCandidates('', [() => { throw new Error('parse'); }, () => [product]]); assert.equal(r.deals.length, 1); assert.equal(r.diagnostics[0].status, 'parse_error'); });
test('dedupe uses retailer-scoped UPC across source URLs', () => { const d = { retailer: 'Target', upc: '123456789012', productUrl: 'https://www.target.com/p/one' }; assert.equal(dedupeDeals([d, { ...d, productUrl: 'https://www.target.com/p/two' }, { ...d, retailer: 'Walmart' }]).length, 2); });
test('dedupe normalizes URL tracking when no ID', () => assert.equal(dedupeDeals([{ retailer: 'Target', productUrl: 'https://www.target.com/p/a?utm_source=x' }, { retailer: 'Target', productUrl: 'https://www.target.com/p/a' }]).length, 1));
const candidates = Array.from({ length: 18 }, (_, i) => ({ id: String(i), retailer: i < 10 ? 'Target' : "Kohl's", salePrice: 50, discountPercent: 50, brand: 'Brand', model: 'M1', category: 'Tools', availability: 'unknown' }));
test('candidate ranking is global capped at eight', () => assert.equal(rankCandidates(candidates, { remaining: 200 }).selected.length, 8));
test('candidate ranking max four per retailer', () => { const r = rankCandidates(candidates, { remaining: 200 }); assert.equal(r.selected.filter(d => d.retailer === 'Target').length, 4); });
test('candidate limit respects two requests per analysis', () => assert.equal(rankCandidates(candidates, { remaining: 5 }).selected.length, 2));
test('exhausted budget selects zero candidates', () => assert.equal(rankCandidates(candidates, { remaining: 0 }).selected.length, 0));
test('unknown budget fails closed', () => assert.equal(rankCandidates(candidates, { remaining: NaN }).selected.length, 0));
test('retailer cap cannot be raised by input', () => assert.equal(rankCandidates(candidates.filter(d => d.retailer === 'Target'), { remaining: 200, maxPerRetailer: 100 }).selected.length, 4));
test('priority allocation remains Product > Manual > Scheduled', () => { assert.ok(budgetLimits({}, 'product').usableDaily > budgetLimits({}, 'manual').usableDaily); assert.ok(budgetLimits({}, 'manual').usableDaily > budgetLimits({}, 'scheduled').usableDaily); });
test('prefilter respects remaining minute quota', () => assert.equal(candidateRequestCapacity({ status: 'Healthy', remaining: 100, limits: { usableMinute: 10 }, minute: 10, minute_count: 8 }, 600000), 2));
test('minute quota resets at bucket boundary', () => assert.equal(candidateRequestCapacity({ status: 'Healthy', remaining: 100, limits: { usableMinute: 10 }, minute: 9, minute_count: 8 }, 600000), 10));
test('cooldown prefilter starts no paid analysis', () => assert.equal(candidateRequestCapacity({ status: 'Cooling Down', remaining: 100, limits: { usableMinute: 10 } }), 0));
test('scheduled clearance without reference price remains eligible', () => assert.equal(rankCandidates([{ ...candidates[0], discountPercent: null, dealType: 'clearance' }], { remaining: 10, scheduled: true }).selected.length, 1));
test('out of stock not selected', () => assert.equal(rankCandidates([{ ...candidates[0], availability: 'out_of_stock' }], { remaining: 10 }).selected.length, 0));
test('prescore favors identifiable tools without promising profit', () => { const strong = candidatePreScore(candidates[0]), weak = candidatePreScore({ salePrice: 2 }); assert.ok(strong.score > weak.score); assert.match(strong.purpose, /not resale profit/); });
test('all registered providers included without frontend store list', () => assert.equal(RETAILER_PROVIDERS.length, 4));
test('dynamic retailer selector renders API stores and keeps selection', () => {
  const code = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = code.indexOf('function updateRetailerOptions('), end = code.indexOf('\n}', start) + 2;
  const select = { value: "Kohl's", replaceChildren(...values) { this.options = values; } };
  const context = { $: () => select, Option: function(label, value) { this.label = label; this.value = value; } };
  vm.runInNewContext(`${code.slice(start, end)}\nupdateRetailerOptions({providers:[{retailer:"Kohl's"},{retailer:'New Retailer'}]});`, context);
  assert.equal(select.value, "Kohl's"); assert.equal(select.options.length, 3); assert.equal(select.options[2].label, 'New Retailer');
});
