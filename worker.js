const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const API_TIMEOUT_MS = 18000;
const LISTINGS_SOURCE = 'eBay Sold Listings API';
const RATE_LIMIT = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        enforceRateLimit(request);
        assertConfigured(env);
        const body = await readJson(request);
        validateImage(body.productImage);

        const fetchedAt = new Date();
        const identified = await identifyProduct(body.productImage, env, fetchedAt);
        const searchPlan = buildSearchPlan(identified);
        if (!searchPlan.primary) {
          return json({ error: '商品を特定できませんでした。UPC、型番、商品ラベルがはっきり写る写真でもう一度試してください。' }, 422);
        }

        const provider = createListingsProvider(env);
        const [activeResult, soldResult] = await Promise.all([
          provider.search(searchPlan, identified, false),
          provider.search(searchPlan, identified, true)
        ]);

        return json(calculateResearch({ identified, searchPlan, activeResult, soldResult, body, fetchedAt }));
      } catch (e) {
        return json({ error: e?.message || String(e), status: 'API unavailable' }, e?.status || 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

function assertConfigured(env) {
  if (!env.OPENAI_API_KEY) throw withStatus('OPENAI_API_KEY が設定されていません', 500);
  if (!env.EBAY_SOLD_API_URL || !env.EBAY_SOLD_API_KEY) {
    throw withStatus('EBAY_SOLD_API_URL / EBAY_SOLD_API_KEY が設定されていません', 500);
  }
}

function enforceRateLimit(request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now();
  const current = RATE_LIMIT.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (current.resetAt <= now) {
    RATE_LIMIT.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  current.count += 1;
  RATE_LIMIT.set(ip, current);
  if (current.count > RATE_LIMIT_MAX) throw withStatus('短時間のリクエストが多すぎます。少し待ってから再試行してください。', 429);
}

async function identifyProduct(image, env, asOf) {
  const prompt = `You are a product identification engine for US retail-to-eBay resale research.
Today: ${asOf.toISOString().slice(0, 10)}.
Read the attached product photo or barcode/UPC photo. Return only structured JSON.

Identify as precisely as visible:
- brand
- exact product/model name
- model number / MPN
- UPC/GTIN/EAN digits
- size, color, variation
- category
- important specifications
- a match confidence: High, Medium, or Low
- search keywords for eBay when UPC/model are unavailable
- practical packed weight and dimensions for shipping estimates

UPC/GTIN must be digits only. Do not invent a UPC, model, size, or color. If uncertain use null.`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      brand: { type: ['string', 'null'] },
      product_name: { type: 'string' },
      model: { type: ['string', 'null'] },
      upc_gtin_ean: { type: ['string', 'null'] },
      size: { type: ['string', 'null'] },
      color: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      specifications: { type: 'array', items: { type: 'string' } },
      condition: { type: ['string', 'null'] },
      observed_price: { type: ['number', 'null'] },
      search_keywords: { type: 'string' },
      packed_weight_lb: { type: ['number', 'null'] },
      packed_length_in: { type: ['number', 'null'] },
      packed_width_in: { type: ['number', 'null'] },
      packed_height_in: { type: ['number', 'null'] },
      shipping_estimate_confidence: { type: 'string' },
      match_confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      identification_notes: { type: 'string' }
    },
    required: ['brand', 'product_name', 'model', 'upc_gtin_ean', 'size', 'color', 'category', 'specifications', 'condition', 'observed_price', 'search_keywords', 'packed_weight_lb', 'packed_length_in', 'packed_width_in', 'packed_height_in', 'shipping_estimate_confidence', 'match_confidence', 'identification_notes']
  };

  const raw = await fetchJsonWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: image, detail: 'high' }
      ] }],
      text: { format: { type: 'json_schema', name: 'product_identification', strict: true, schema } }
    })
  }, API_TIMEOUT_MS, '商品画像のAI解析に失敗しました');

  return JSON.parse(extractOutputText(raw));
}

function buildSearchPlan(p) {
  const upc = normalizeDigits(p.upc_gtin_ean);
  const model = clean(p.model);
  const brand = clean(p.brand);
  const product = clean(p.product_name);
  const size = clean(p.size);
  const color = clean(p.color);
  const keywords = clean(p.search_keywords);

  const queries = [];
  if (upc) queries.push({ type: 'upc_gtin', value: upc });
  if (model) queries.push({ type: 'model', value: [brand, model, size, color].filter(Boolean).join(' ') });
  if (brand && product) queries.push({ type: 'brand_product', value: [brand, product, size, color].filter(Boolean).join(' ') });
  if (keywords) queries.push({ type: 'ai_keywords', value: keywords });

  return { primary: queries[0]?.value || '', strategy: queries[0]?.type || 'none', queries };
}

function createListingsProvider(env) {
  return new EbaySoldListingsProvider(env);
}

class EbaySoldListingsProvider {
  constructor(env) {
    this.url = env.EBAY_SOLD_API_URL;
    this.key = env.EBAY_SOLD_API_KEY;
  }

  async search(searchPlan, identified, sold) {
    const kind = sold ? 'Sold' : 'Active';
    try {
      const url = new URL(this.url);
      url.searchParams.set('keyword', searchPlan.primary);
      url.searchParams.set('sold', String(sold));
      url.searchParams.set('count', '240');
      url.searchParams.set('itemCondition', providerCondition(identified.condition));

      const data = await fetchProviderJson(url, this.key, `${kind} Provider unavailable`);
      if (!Array.isArray(data.results)) throw new Error(`${kind} Provider returned an invalid response`);

      const listings = data.results
        .map(item => normalizeProviderListing(item, sold))
        .filter(item => isLikelySameProduct(item, identified));
      return {
        ok: true,
        source: LISTINGS_SOURCE,
        query: searchPlan.primary,
        total: listings.length,
        source_total: Number.isInteger(data.count) ? data.count : data.results.length,
        listings,
        fetched_at: new Date().toISOString()
      };
    } catch (e) {
      return unavailable(LISTINGS_SOURCE, e?.message || `${kind}取得失敗`);
    }
  }
}

function providerCondition(condition) {
  const value = clean(condition).toLowerCase();
  if (/new|新品|未使用/.test(value)) return 'new';
  if (/used|pre.?owned|中古/.test(value)) return 'used';
  return 'any';
}

function calculateResearch({ identified, searchPlan, activeResult, soldResult, body, fetchedAt }) {
  const active = dedupe((activeResult.listings || []).filter(x => Number.isFinite(x.totalPrice)));
  const sold = dedupe((soldResult.listings || []).filter(x => Number.isFinite(x.totalPrice)));
  const now = new Date(fetchedAt);

  const activePrices = withoutOutliers(active.map(x => x.totalPrice));
  const soldFirm = sold.filter(x => !x.bestOffer).map(x => x.totalPrice);
  const soldAll = sold.map(x => x.totalPrice);
  const soldPrices = withoutOutliers(soldFirm.length >= 2 ? soldFirm : soldAll);

  const sold7 = countWithin(sold, now, 7);
  const sold30 = countWithin(sold, now, 30);
  const sold90 = countWithin(sold, now, 90);
  const activeCount = activeResult.ok ? (Number.isInteger(activeResult.total) ? activeResult.total : active.length) : null;

  const soldStats = stats(soldPrices);
  const activeStats = stats(activePrices);
  const overrides = readOverrides(body);
  const priceDecision = chooseSalePrice({ soldStats, activeStats, sold30, sold90, overridePrice: overrides.targetSalePrice });

  const shipping = estimateShipping(identified, active, overrides.shippingCost);
  const fee = estimateEbayFees(identified.category, priceDecision.price, shipping.buyerPaidShipping, overrides);
  const cost = overrides.cost ?? nullableNumber(identified.observed_price);
  const promotedCost = priceDecision.price * (overrides.promotedRate / 100);
  const grossCollected = priceDecision.price + shipping.buyerPaidShipping;
  const netProfit = cost == null || !Number.isFinite(priceDecision.price) || priceDecision.price <= 0
    ? null
    : grossCollected - cost - fee.total - shipping.sellerCost - overrides.packaging - promotedCost;
  const roi = netProfit != null && cost > 0 ? (netProfit / cost) * 100 : null;
  const sellThrough = activeCount > 0 ? (sold90 / activeCount) * 100 : null;
  const soldThroughInventoryRatio = activeCount != null ? (sold90 / Math.max(1, sold90 + activeCount)) * 100 : null;
  const pace30 = sold30 > 0 ? 30 / sold30 : null;
  const pace90 = sold90 > 0 ? 90 / sold90 : null;
  const averagePace = pace30 ?? pace90;
  const verdict = decideVerdict({ netProfit, roi, sellThrough, sold30, sold90, activeCount, matchConfidence: identified.match_confidence, shipping });

  const warnings = [];
  if (!activeResult.ok) warnings.push('Active Listingsは取得失敗です。0件として扱わず、データ不足として判定しています。');
  if (!soldResult.ok) warnings.push('Sold Listingsは取得失敗です。0 Soldとして扱わず、データ不足として判定しています。');
  if (sold.some(x => x.bestOffer)) warnings.push('Best Offerの表示価格は実際の成約価格と異なる可能性があります。');
  if (priceDecision.confidence === 'Low') warnings.push('Soldデータが不足しているため、想定販売価格の推定精度が低いです。');
  if (shipping.estimated) warnings.push(`推定送料と推定重量を使用しています。${shipping.label}`);

  return {
    version: '2.2',
    product: {
      name: identified.product_name,
      brand: identified.brand,
      model: identified.model,
      upcGtinEan: normalizeDigits(identified.upc_gtin_ean),
      size: identified.size,
      color: identified.color,
      category: identified.category,
      specifications: identified.specifications || [],
      matchConfidence: identified.match_confidence,
      notes: identified.identification_notes
    },
    search: searchPlan,
    active: {
      ok: activeResult.ok,
      source: activeResult.source,
      query: activeResult.query,
      count: activeCount,
      stats: activeStats,
      listings: active.slice(0, 25)
    },
    sold: {
      ok: soldResult.ok,
      source: soldResult.source,
      query: soldResult.query,
      total: soldResult.ok ? (Number.isInteger(soldResult.total) ? soldResult.total : sold.length) : null,
      count7d: soldResult.ok ? sold7 : null,
      count30d: soldResult.ok ? sold30 : null,
      count90d: soldResult.ok ? sold90 : null,
      stats: soldStats,
      pace30Days: pace30,
      pace90Days: pace90,
      averageDaysPerSale: averagePace,
      listings: sold.slice(0, 25)
    },
    market: {
      sellThrough90d: sellThrough,
      soldThroughInventoryRatio,
      sellThroughFormula: '90日Sold ÷ Active × 100',
      targetSalePrice: priceDecision.price,
      targetSalePriceSource: priceDecision.source,
      priceConfidence: priceDecision.confidence
    },
    profit: {
      cost,
      buyerPaidShipping: shipping.buyerPaidShipping,
      sellerShippingCost: shipping.sellerCost,
      shippingLabel: shipping.label,
      estimatedWeightLb: shipping.weightLb,
      shippingDifficulty: shipping.difficulty,
      packaging: overrides.packaging,
      feeRate: fee.rate,
      perOrderFee: fee.fixed,
      promotedRate: overrides.promotedRate,
      promotedCost,
      estimatedEbayFees: fee.total,
      grossCollected,
      netProfit,
      roi
    },
    verdict,
    status: activeResult.ok && soldResult.ok ? 'OK' : activeResult.ok || soldResult.ok ? 'PARTIAL' : 'DATA_UNAVAILABLE',
    sources: {
      product: 'OpenAI Vision',
      active: activeResult.source || LISTINGS_SOURCE,
      sold: soldResult.source || LISTINGS_SOURCE,
      updated: fetchedAt.toISOString()
    },
    warnings,
    errors: [activeResult.error, soldResult.error].filter(Boolean)
  };
}

function normalizeProviderListing(item, sold) {
  const providerTotal = nullableNumber(item.totalPrice);
  const price = nullableNumber(item.soldPrice ?? item.currentPrice ?? item.price ?? item.value ?? providerTotal);
  const shipping = nullableNumber(item.shippingPrice ?? item.shipping ?? item.shippingCost) ?? 0;
  return {
    title: item.title || '',
    price,
    shipping,
    totalPrice: providerTotal ?? (price == null ? null : price + shipping),
    soldDate: sold ? normalizeDate(item.soldDate ?? item.dateSold ?? item.endedAt) : null,
    condition: item.condition || null,
    itemId: item.itemId || item.id || null,
    url: item.url || item.itemWebUrl || null,
    bestOffer: Boolean(item.bestOffer ?? item.best_offer ?? item.isBestOffer ?? /offer/i.test(item.buyingFormat || '')),
    seller: item.sellerUsername || item.seller?.username || item.seller || null,
    gtin: item.gtin || item.upc || item.ean || null,
    mpn: item.mpn || item.model || null,
    thumbnailUrl: item.thumbnailUrl || null
  };
}

function isLikelySameProduct(listing, p) {
  const title = comparableText(listing.title);
  if (!title) return false;
  const gtin = normalizeDigits(p.upc_gtin_ean);
  const listingGtin = normalizeDigits(listing.gtin);
  if (gtin && listingGtin) return listingGtin === gtin;
  if (gtin && title.replace(/\D/g, '').includes(gtin)) return true;

  const model = comparableText(p.model);
  const brand = comparableText(p.brand);
  const product = comparableText(p.product_name);
  const size = comparableText(p.size);
  const color = comparableText(p.color);
  if (model && !includesLoose(title, model)) return false;
  if (brand && !includesLoose(title, brand)) return false;

  const knownColors = ['black', 'white', 'red', 'blue', 'navy', 'green', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'silver', 'gold', 'brown', 'beige'];
  const listedColors = knownColors.filter(value => title.split(' ').includes(value));
  if (color && listedColors.length && !includesLoose(title, color)) return false;

  const numericSize = size.match(/\b\d+(?:\.\d+)?\b/)?.[0];
  const titleSize = title.match(/\bsize\s*(\d+(?:\.\d+)?)\b/)?.[1];
  if (numericSize && titleSize && numericSize !== titleSize) return false;

  if (model) return true;
  const productTokens = meaningfulTokens(product);
  const matchingProductTokens = productTokens.filter(token => title.split(' ').includes(token)).length;
  if (brand && productTokens.length && matchingProductTokens < Math.ceil(productTokens.length / 2)) return false;
  return Boolean(gtin || brand || matchingProductTokens >= 2 || (size && includesLoose(title, size)) || (color && includesLoose(title, color)));
}

function comparableText(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function includesLoose(haystack, needle) {
  if (!needle) return true;
  return haystack.includes(needle) || haystack.replace(/\s/g, '').includes(needle.replace(/\s/g, ''));
}

function meaningfulTokens(value) {
  const stop = new Set(['and', 'the', 'with', 'for', 'new', 'size', 'color', 'model']);
  return [...new Set(value.split(' ').filter(token => token.length > 2 && !stop.has(token)))];
}

function chooseSalePrice({ soldStats, activeStats, sold30, sold90, overridePrice }) {
  if (Number.isFinite(overridePrice) && overridePrice > 0) return { price: overridePrice, source: '手動上書き', confidence: 'Manual' };
  if (soldStats.median != null) {
    const trend = sold30 >= 3 && soldStats.average != null ? (soldStats.median * 0.7 + soldStats.average * 0.3) : soldStats.median;
    return { price: trend, source: 'Sold中央値優先', confidence: sold90 >= 3 ? 'High' : 'Medium' };
  }
  if (activeStats.median != null) return { price: activeStats.median, source: 'Active中央値補助', confidence: 'Low' };
  return { price: 0, source: 'データ不足', confidence: 'Low' };
}

function estimateEbayFees(category, salePrice, buyerShipping, overrides) {
  const rate = overrides.feeRate ?? feeRateForCategory(category);
  const fixed = overrides.perOrderFee;
  return { rate, fixed, total: (salePrice + buyerShipping) * (rate / 100) + fixed };
}

function feeRateForCategory(category = '') {
  const c = String(category || '').toLowerCase();
  if (/shoe|clothing|apparel|fashion/.test(c)) return 13.25;
  if (/card|collectible|toy|game/.test(c)) return 13.25;
  if (/electronic|camera|computer|video game console/.test(c)) return 12.9;
  if (/auto|parts|motor/.test(c)) return 12.35;
  if (/musical/.test(c)) return 7.35;
  return 13.6;
}

function estimateShipping(p, activeListings, manualShipping) {
  const activeShipping = med(activeListings.map(x => x.shipping).filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b));
  const buyerPaidShipping = activeShipping ?? 0;
  if (Number.isFinite(manualShipping)) {
    return { sellerCost: manualShipping, buyerPaidShipping, estimated: false, label: '手動指定送料', weightLb: nullableNumber(p.packed_weight_lb), difficulty: 'Manual override' };
  }

  const weight = nullableNumber(p.packed_weight_lb) ?? 1.5;
  const l = nullableNumber(p.packed_length_in);
  const w = nullableNumber(p.packed_width_in);
  const h = nullableNumber(p.packed_height_in);
  const dimensional = [l, w, h].every(Number.isFinite) ? (l * w * h) / 139 : 0;
  const billable = Math.max(weight, dimensional);
  const sellerCost = billable <= 0.5 ? 5.25 : billable <= 1 ? 6.75 : billable <= 2 ? 8.75 : billable <= 3 ? 10.5 : billable <= 5 ? 13.5 : billable <= 10 ? 19.5 : 29;
  const difficulty = billable > 5 || dimensional > weight * 1.5 ? 'Bulky/verify dimensions' : 'Standard';
  return {
    sellerCost,
    buyerPaidShipping,
    estimated: true,
    label: `推定送料（推定重量 約${billable.toFixed(1)}lb / ${p.shipping_estimate_confidence || 'confidence不明'}）`,
    weightLb: billable,
    difficulty
  };
}

function decideVerdict({ netProfit, roi, sellThrough, sold30, sold90, activeCount, matchConfidence, shipping }) {
  const reasons = [];
  if (netProfit == null || roi == null) return { label: 'MAYBE', reasons: ['仕入れ価格または販売価格データが不足しています'] };
  if (matchConfidence !== 'High') reasons.push(`商品一致精度が${matchConfidence}`);
  if (shipping.difficulty !== 'Standard') reasons.push('送料・サイズ確認が必要');
  if (activeCount === null || sellThrough === null) reasons.push('ActiveまたはSoldデータ不足');

  if (netProfit >= 10 && roi >= 50 && (sellThrough == null || sellThrough >= 30) && sold90 >= 2 && matchConfidence !== 'Low') {
    reasons.unshift(`利益$${netProfit.toFixed(2)}、ROI ${roi.toFixed(0)}%、30日で${sold30}個販売`);
    return { label: 'BUY', reasons };
  }
  if (netProfit < 5 || roi < 20 || sold90 === 0 || (activeCount != null && activeCount > 80 && sold90 < 3)) {
    reasons.unshift(`利益$${netProfit.toFixed(2)}、ROI ${roi.toFixed(0)}%、90日Sold ${sold90}`);
    return { label: 'SKIP', reasons };
  }
  reasons.unshift(`利益$${netProfit.toFixed(2)}、ROI ${roi.toFixed(0)}%、90日Sold ${sold90}`);
  return { label: 'MAYBE', reasons };
}

function readOverrides(body) {
  return {
    cost: nullableNumber(body.cost),
    packaging: nullableNumber(body.packaging) ?? 0.5,
    feeRate: nullableNumber(body.feeRate),
    perOrderFee: nullableNumber(body.perOrderFee ?? body.fixedFee) ?? 0.4,
    promotedRate: nullableNumber(body.promotedRate) ?? 0,
    shippingCost: nullableNumber(body.shippingCost),
    targetSalePrice: nullableNumber(body.targetSalePrice)
  };
}

function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { count: 0, average: null, median: null, min: null, max: null };
  return {
    count: v.length,
    average: v.reduce((a, b) => a + b, 0) / v.length,
    median: med(v),
    min: v[0],
    max: v[v.length - 1]
  };
}

function withoutOutliers(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 5) return v;
  const q1 = percentile(v, 0.25);
  const q3 = percentile(v, 0.75);
  const iqr = q3 - q1;
  return v.filter(x => x >= q1 - iqr * 1.5 && x <= q3 + iqr * 1.5);
}

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(x => {
    const key = [x.itemId, clean(x.title).toLowerCase(), normalizeDate(x.soldDate), Number(x.totalPrice || 0).toFixed(2)].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countWithin(items, now, days) {
  const end = now.getTime();
  const start = end - days * 86400000;
  return items.filter(x => {
    const t = normalizeDate(x.soldDate);
    if (!t) return false;
    const ms = new Date(`${t}T00:00:00Z`).getTime();
    return ms >= start && ms <= end;
  }).length;
}

function nullableNumber(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function med(a) {
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function validateImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') throw withStatus('商品写真またはバーコード写真を入れてください', 400);
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,/i);
  if (!match) throw withStatus('JPEG / PNG / WebP / HEIC の画像をアップロードしてください', 400);
  const bytes = Math.ceil((dataUrl.length - match[0].length) * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) throw withStatus('画像サイズが大きすぎます。7MB以下にしてください', 413);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw withStatus('JSONリクエストを読み取れませんでした', 400);
  }
}

async function fetchJsonWithTimeout(url, init, timeoutMs, fallbackMessage) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(data?.error_description || data?.error?.message || data?.message || fallbackMessage);
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${fallbackMessage}: timeout`);
    throw e;
  } finally {
    clearTimeout(id);
  }
}

async function fetchProviderJson(url, apiKey, fallbackMessage) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal
      });
      const text = await resp.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`${fallbackMessage}: invalid JSON`);
      }
      if (resp.ok) return data;
      if (resp.status === 429 && attempt === 0) {
        const retryAfter = Math.max(1, Math.min(5, Number(resp.headers.get('retry-after')) || 1));
        await delay(retryAfter * 1000);
        continue;
      }
      const detail = data?.error_description || data?.error?.message || data?.error || data?.message;
      throw new Error(`${fallbackMessage} (${resp.status})${detail ? `: ${detail}` : ''}`);
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error(`${fallbackMessage}: timeout`);
      throw e;
    } finally {
      clearTimeout(id);
    }
  }
  throw new Error(fallbackMessage);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractOutputText(raw) {
  if (raw.output_text) return raw.output_text;
  for (const item of raw.output || []) {
    for (const c of item.content || []) if (c.type === 'output_text' && c.text) return c.text;
  }
  throw new Error('OpenAIからJSON出力を取得できませんでした');
}

function unavailable(source, error) {
  return { ok: false, source, query: null, total: null, listings: [], error, fetched_at: new Date().toISOString() };
}

function withStatus(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'POST, OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(v, status = 200) {
  return cors(new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json;charset=utf-8' } }));
}
