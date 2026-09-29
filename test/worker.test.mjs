import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const env = {
  OPENAI_API_KEY: 'test-openai-key',
  EBAY_SOLD_API_URL: 'https://provider.test/scrape',
  EBAY_SOLD_API_KEY: 'test-provider-key',
  ASSETS: { fetch: () => new Response('asset') }
};

test('Product Scan keeps the existing API contract', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.includes('api.openai.com')) {
      return Response.json({ output_text: JSON.stringify(productIdentification()) });
    }
    return providerResponse(new URL(target));
  };
  try {
    const response = await worker.fetch(new Request('https://worker.test/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productImage: 'data:image/png;base64,AAAA', cost: 50 })
    }), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.version, '2.5');
    assert.equal(data.product.model, 'DCD771C2');
    assert.equal(data.sold.count90d, 3);
    assert.equal(data.active.count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Deal Scan analyzes six mock deals without one failure stopping the batch', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async url => {
    providerCalls += 1;
    const target = new URL(String(url));
    if (target.searchParams.get('keyword') === '622356536820' && target.searchParams.get('sold') === 'false') {
      return Response.json({ error: 'temporary upstream failure' }, { status: 502 });
    }
    return providerResponse(target);
  };
  try {
    const response = await worker.fetch(new Request('https://worker.test/api/deals/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'mock', filters: { minimumProfit: 0, minimumRoi: 0, minimumDiscount: 0 }, sortBy: 'dealScore' })
    }), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.version, '2.5');
    assert.equal(data.counts.fetched, 6);
    assert.equal(data.counts.analyzed, 6);
    assert.equal(data.deals.length, 6);
    assert.ok(data.deals.some(item => item.status === 'PARTIAL'));
    assert.ok(data.deals.every(item => item.sources.deal === 'Mock Deal Provider'));
    assert.ok(providerCalls >= 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Live retailer failure is isolated while another provider continues', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.includes('walmart.com/shop/deals/clearance')) return new Response(walmartHtml());
    if (target.includes('target.com/c/clearance')) return new Response('<html><body>Client-rendered clearance page</body></html>');
    if (target.includes('homedepot.com/daily-deals')) return new Response('blocked', { status: 403 });
    return providerResponse(new URL(target));
  };
  try {
    const response = await worker.fetch(new Request('https://worker.test/api/deals/scan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'live', filters: { minimumProfit: 0, minimumRoi: 0, minimumDiscount: 0 } })
    }), env);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.counts.fetched, 1);
    assert.equal(data.providers.find(provider => provider.retailer === 'Walmart').status, 'ok');
    assert.equal(data.providers.find(provider => provider.retailer === 'Target').status, 'unavailable');
    assert.equal(data.providers.find(provider => provider.retailer === 'Home Depot').status, 'error');
    assert.equal(data.deals.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function providerResponse(url) {
  const sold = url.searchParams.get('sold') === 'true';
  const keyword = url.searchParams.get('keyword');
  const title = keyword === 'ZXQ-9999' ? 'MockWorks Workshop Widget ZXQ-9999' : `Matched product ${keyword}`;
  const prices = sold ? [139, 145, 151] : [159, 169];
  return Response.json({
    count: prices.length,
    results: prices.map((price, index) => ({
      itemId: `${keyword}-${sold ? 's' : 'a'}-${index}`,
      title,
      upc: /^\d{8,14}$/.test(keyword) ? keyword : null,
      soldPrice: String(price),
      shippingPrice: '0',
      totalPrice: String(price),
      endedAt: sold ? new Date(Date.now() - index * 86400000).toISOString().slice(0, 10) : null,
      condition: 'New',
      sellerUsername: 'test-seller'
    }))
  });
}

function productIdentification() {
  return {
    brand: 'DEWALT', product_name: '20V MAX Cordless Drill Driver Kit', model: 'DCD771C2', upc_gtin_ean: '885911325905',
    size: null, color: null, category: 'Power Tools', specifications: ['20V'], condition: 'New', observed_price: null,
    search_keywords: 'DEWALT DCD771C2', packed_weight_lb: 5.2, packed_length_in: null, packed_width_in: null,
    packed_height_in: null, shipping_estimate_confidence: 'Medium', match_confidence: 'High', identification_notes: 'test'
  };
}

function walmartHtml() {
  const item = {
    __typename: 'Product', id: 'live-1', usItemId: 'live-1', name: 'Live Walmart Drill', brand: 'Acme',
    priceInfo: { linePrice: '$49.00', wasPrice: '$99.00' }, canonicalUrl: '/ip/live-drill/live-1',
    imageInfo: { thumbnailUrl: 'https://img.test/live.jpg' }, availabilityStatusDisplayValue: 'In stock',
    fulfillmentSummary: [{ fulfillment: 'DELIVERY' }]
  };
  const data = { props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: [item] }] } } } } };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}
