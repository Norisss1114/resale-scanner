import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WalmartDealProvider, clearRetailerCacheForTests, dedupeDeals,
  normalizeHomeDepotDeal, normalizeTargetDeal, normalizeWalmartDeal,
  parseHomeDepotDeals, parseTargetDeals, parseWalmartDeals
} from '../lib/retailer-providers.mjs';

test('Retailer normalizers produce the shared Deal shape', () => {
  const walmart = normalizeWalmartDeal({ id: 'w1', usItemId: '123', name: 'Walmart Tool', brand: 'Acme', priceInfo: { linePrice: '$50.00', wasPrice: '$100.00' }, canonicalUrl: '/ip/tool/123', imageInfo: { thumbnailUrl: 'https://img.test/w.jpg' }, availabilityStatusDisplayValue: 'In stock', fulfillmentSummary: [{ fulfillment: 'DELIVERY' }] });
  const target = normalizeTargetDeal({ '@type': 'Product', name: 'Target Tool', sku: 't1', brand: { name: 'Acme' }, image: 'https://img.test/t.jpg', url: '/p/tool/-/A-1', regularPrice: 80, offers: { price: 40, availability: 'InStock' } });
  const home = normalizeHomeDepotDeal(homeProduct());
  for (const deal of [walmart, target, home]) {
    assert.ok(deal.id);
    assert.ok(deal.retailer);
    assert.ok(deal.regularPrice > deal.salePrice);
    assert.ok(deal.discountPercent > 0);
    assert.ok(deal.productUrl.startsWith('https://'));
    assert.equal(deal.providerStatus, 'ok');
  }
  assert.equal(home.sourceType, 'daily_deal');
});

test('Structured parsers distinguish valid empty data from missing structures', () => {
  const walmartEmpty = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { searchResult: { itemStacks: [] } } } } })}</script>`;
  assert.deepEqual(parseWalmartDeals(walmartEmpty), []);
  assert.throws(() => parseWalmartDeals('<html></html>'), /__NEXT_DATA__/);
  assert.deepEqual(parseTargetDeals('<html><script type="application/ld+json">{"@type":"CollectionPage"}</script></html>'), []);
  assert.equal(parseHomeDepotDeals(homeHtml()).length, 1);
});

test('Duplicate deals are removed without mixing retailers', () => {
  const base = { id: '1', retailer: 'Walmart', productUrl: 'https://walmart.test/item' };
  const deals = dedupeDeals([base, { ...base, id: '2' }, { ...base, retailer: 'Target' }]);
  assert.equal(deals.length, 2);
});

test('Walmart public JSON-LD fallback preserves retailer identity and explicit prices', () => {
  const html = '<script type="application/ld+json">{"@type":"Product","name":"Tool","sku":"123","url":"/ip/tool/123","regularPrice":60,"offers":{"price":30}}</script>';
  const [deal] = parseWalmartDeals(html);
  assert.equal(deal.retailer, 'Walmart');
  assert.equal(deal.salePrice, 30);
  assert.equal(deal.productUrl, 'https://www.walmart.com/ip/tool/123');
  assert.equal(normalizeTargetDeal({ name: 'Tool', offers: { lowPrice: 30, highPrice: 60 } }), null);
});

test('Provider reports empty separately from request failure', async () => {
  clearRetailerCacheForTests();
  const emptyProvider = new WalmartDealProvider({ fetcher: async () => new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { searchResult: { itemStacks: [] } } } } })}</script>`) });
  assert.equal((await emptyProvider.listDeals()).status, 'empty');
  clearRetailerCacheForTests();
  const failedProvider = new WalmartDealProvider({ fetcher: async () => new Response('blocked', { status: 403 }) });
  assert.equal((await failedProvider.listDeals()).status, 'unavailable');
});

function homeProduct() {
  return {
    __typename: 'BaseProduct', itemId: '456', identifiers: { itemId: '456', brandName: 'DEWALT', productLabel: 'Drill Kit', canonicalUrl: '/p/DEWALT-Drill-Kit-DCD1/456', storeSkuNumber: '1001' },
    'pricing({"storeId":"8119"})': { value: 59, original: 129, promotion: { savingsCenter: 'Special Buys' } },
    media: { images: [{ subType: 'PRIMARY', url: 'https://img.test/<SIZE>.jpg' }] }, availabilityType: { buyable: true, type: 'Online' }
  };
}

function homeHtml() {
  return `<script>window.__APOLLO_STATE__=${JSON.stringify({ 'base-searchNav-456': homeProduct() })};window.next=true;</script>`;
}
