const RETAILER_CACHE_TTL_MS = 10 * 60 * 1000;
const RETAILER_TIMEOUT_MS = 15_000;
const MAX_DEALS_PER_PROVIDER = 6;
const RETAILER_CACHE = new Map();

export class WalmartDealProvider {
  constructor(options = {}) {
    this.name = 'Walmart';
    this.source = 'walmart_public_clearance';
    this.mock = false;
    this.url = 'https://www.walmart.com/shop/deals/clearance';
    this.fetcher = options.fetcher || fetch;
  }

  async listDeals() {
    return cachedProviderResult(this.name, this.url, async () => {
      const html = await fetchRetailerHtml(this.url, this.fetcher);
      const deals = parseWalmartDeals(html).slice(0, MAX_DEALS_PER_PROVIDER);
      return providerResult(this.name, deals.length ? 'ok' : 'empty', deals, this.source);
    });
  }
}

export class TargetDealProvider {
  constructor(options = {}) {
    this.name = 'Target';
    this.source = 'target_public_clearance';
    this.mock = false;
    this.url = 'https://www.target.com/c/clearance/-/N-5q0ga';
    this.fetcher = options.fetcher || fetch;
  }

  async listDeals() {
    return cachedProviderResult(this.name, this.url, async () => {
      const html = await fetchRetailerHtml(this.url, this.fetcher);
      const deals = parseTargetDeals(html).slice(0, MAX_DEALS_PER_PROVIDER);
      if (!deals.length) {
        if (hasTargetStructuredProducts(html)) return providerResult(this.name, 'empty', [], this.source);
        return providerResult(this.name, 'unavailable', [], this.source, '公開HTMLに商品structured dataがありません。Targetの商品一覧はクライアント側取得のため、非公開endpointは使用していません。');
      }
      return providerResult(this.name, 'ok', deals, this.source);
    });
  }
}

export class HomeDepotDealProvider {
  constructor(options = {}) {
    this.name = 'Home Depot';
    this.source = 'homedepot_daily_deals';
    this.mock = false;
    this.url = 'https://www.homedepot.com/daily-deals';
    this.fetcher = options.fetcher || fetch;
  }

  async listDeals() {
    return cachedProviderResult(this.name, this.url, async () => {
      const html = await fetchRetailerHtml(this.url, this.fetcher);
      const deals = parseHomeDepotDeals(html).slice(0, MAX_DEALS_PER_PROVIDER);
      return providerResult(this.name, deals.length ? 'ok' : 'empty', deals, this.source);
    });
  }
}

export function parseWalmartDeals(html) {
  const raw = extractScriptById(html, '__NEXT_DATA__');
  let stacks;
  try { stacks = raw ? JSON.parse(raw)?.props?.pageProps?.initialData?.searchResult?.itemStacks : null; } catch { stacks = null; }
  if (!Array.isArray(stacks)) {
    const products = extractJsonLd(html).flatMap(flattenJsonLd).filter(item => item?.['@type'] === 'Product');
    if (!products.length) throw new ProviderUnavailableError('Walmart __NEXT_DATA__ / Product JSON-LDが見つかりません');
    return dedupeDeals(products.map(item => {
      const deal = normalizeTargetDeal({ ...item, url: absoluteUrl('https://www.walmart.com', item.url) });
      return deal ? { ...deal, id: deal.id.replace(/^target_/, 'walmart_'), retailer: 'Walmart', source: 'walmart_public_clearance' } : null;
    }).filter(Boolean)).sort(byDiscountDescending);
  }
  const items = stacks.flatMap(stack => stack?.items || []).filter(item => item?.__typename === 'Product');
  return dedupeDeals(items.map(normalizeWalmartDeal).filter(Boolean)).sort(byDiscountDescending);
}

export function parseTargetDeals(html) {
  const scripts = extractJsonLd(html);
  const products = scripts.flatMap(flattenJsonLd).filter(item => item?.['@type'] === 'Product');
  return dedupeDeals(products.map(normalizeTargetDeal).filter(Boolean)).sort(byDiscountDescending);
}

export function parseHomeDepotDeals(html) {
  const raw = extractAssignedJson(html, 'window.__APOLLO_STATE__');
  if (!raw) throw new ProviderUnavailableError('Home Depot __APOLLO_STATE__が見つかりません');
  const state = JSON.parse(raw);
  const products = Object.entries(state).filter(([key, value]) => key.startsWith('base-searchNav-') && value?.__typename === 'BaseProduct').map(([, value]) => value);
  return dedupeDeals(products.map(normalizeHomeDepotDeal).filter(Boolean)).sort(byDiscountDescending);
}

export function normalizeWalmartDeal(item) {
  const salePrice = priceNumber(item?.priceInfo?.linePrice) ?? finiteNumber(item?.priceInfo?.minPrice);
  const regularPrice = priceNumber(item?.priceInfo?.wasPrice) ?? (salePrice != null && finiteNumber(item?.priceInfo?.savingsAmt) != null ? salePrice + finiteNumber(item.priceInfo.savingsAmt) : null);
  if (!(regularPrice > salePrice && salePrice >= 0)) return null;
  return normalizedDeal({
    id: `walmart_${item.usItemId || item.id}`,
    retailer: 'Walmart', title: item.name, brand: item.brand || item.manufacturerName, model: null, upc: null, gtin: null,
    sku: item.usItemId || item.id, regularPrice, salePrice, imageUrl: item.imageInfo?.thumbnailUrl,
    productUrl: absoluteUrl('https://www.walmart.com', item.canonicalUrl),
    fulfillment: (item.fulfillmentSummary || []).map(entry => entry.fulfillment).filter(Boolean).join(', ').toLowerCase() || null,
    availability: availabilityValue(item.availabilityStatusDisplayValue || item.availabilityStatusV2?.display),
    purchasePopularity: item.socialProof?.text || null,
    source: 'walmart_public_clearance', sourceType: 'clearance', providerStatus: 'ok'
  });
}

export function normalizeTargetDeal(item) {
  const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  const salePrice = finiteNumber(offer?.price ?? offer?.lowPrice);
  // AggregateOffer.highPrice is another offer, not evidence of a former price.
  const regularPrice = finiteNumber(item.regularPrice);
  if (!(regularPrice > salePrice && salePrice >= 0)) return null;
  const image = Array.isArray(item.image) ? item.image[0] : item.image;
  return normalizedDeal({
    id: `target_${item.sku || stableId(item.url || item.name)}`,
    retailer: 'Target', title: item.name, brand: typeof item.brand === 'string' ? item.brand : item.brand?.name,
    model: item.mpn || null, upc: item.gtin12 || null, gtin: item.gtin13 || item.gtin14 || null, sku: item.sku || null,
    regularPrice, salePrice, imageUrl: image?.url || image, productUrl: absoluteUrl('https://www.target.com', item.url),
    fulfillment: offer?.availableDeliveryMethod || null, availability: availabilityValue(offer?.availability), purchasePopularity: null,
    source: 'target_public_clearance', sourceType: 'clearance', providerStatus: 'ok'
  });
}

export function normalizeHomeDepotDeal(item) {
  const pricingKey = Object.keys(item).find(key => key.startsWith('pricing('));
  const pricing = pricingKey ? item[pricingKey] : item.pricing;
  const salePrice = finiteNumber(pricing?.value);
  const regularPrice = finiteNumber(pricing?.original);
  if (!(regularPrice > salePrice && salePrice >= 0)) return null;
  const identifiers = item.identifiers || {};
  const image = item.media?.images?.find(entry => entry.subType === 'PRIMARY') || item.media?.images?.[0];
  const promotion = pricing?.promotion || {};
  return normalizedDeal({
    id: `homedepot_${item.itemId || identifiers.itemId}`,
    retailer: 'Home Depot', title: [identifiers.brandName, identifiers.productLabel].filter(Boolean).join(' '), brand: identifiers.brandName,
    model: identifiers.specialOrderSku || modelFromHomeDepotUrl(identifiers.canonicalUrl), upc: null, gtin: null,
    sku: identifiers.storeSkuNumber || item.itemId, regularPrice, salePrice,
    imageUrl: image?.url?.replace('<SIZE>', '600'), productUrl: absoluteUrl('https://www.homedepot.com', identifiers.canonicalUrl),
    fulfillment: item.availabilityType?.type?.toLowerCase() || null,
    availability: item.availabilityType?.buyable || item.availabilityType?.status ? 'in_stock' : 'unknown',
    dealType: promotion.savingsCenter || promotion.savingsCenterPromos || 'Daily Deal',
    source: 'homedepot_daily_deals', sourceType: 'daily_deal', providerStatus: 'ok'
  });
}

export function dedupeDeals(deals) {
  const seen = new Set();
  return deals.filter(deal => {
    const key = `${deal.retailer}|${deal.productUrl || deal.id}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function clearRetailerCacheForTests() {
  RETAILER_CACHE.clear();
}

async function cachedProviderResult(name, url, loader) {
  const cacheKey = `${name}|${url}`;
  const cached = RETAILER_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cache: 'hit' };
  try {
    const value = await loader();
    RETAILER_CACHE.set(cacheKey, { expiresAt: Date.now() + RETAILER_CACHE_TTL_MS, value });
    return { ...value, cache: 'miss' };
  } catch (error) {
    const status = error instanceof ProviderUnavailableError ? 'unavailable' : 'error';
    return providerResult(name, status, [], null, error?.message || String(error));
  }
}

async function fetchRetailerHtml(url, fetcher) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RETAILER_TIMEOUT_MS);
    try {
      const response = await fetcher(url, { headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'ResaleScanner/2.4 (+https://github.com/Norisss1114/resale-scanner)' }, signal: controller.signal });
      const html = await response.text();
      if (response.ok) return html;
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Math.min(5, Math.max(1, Number(response.headers.get('retry-after')) || 2 ** attempt));
        await delay(retryAfter * 1000);
        continue;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError') lastError = new Error('timeout');
      if (attempt < 2) { await delay((2 ** attempt) * 500); continue; }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Retailer request failed');
}

function normalizedDeal(value) {
  const regularPrice = finiteNumber(value.regularPrice);
  const salePrice = finiteNumber(value.salePrice);
  return {
    id: value.id || stableId(`${value.retailer}|${value.productUrl}|${value.title}`), retailer: value.retailer || null,
    title: value.title || 'Untitled deal', brand: value.brand || null, model: value.model || null, upc: digits(value.upc), gtin: digits(value.gtin), sku: value.sku || null,
    regularPrice, salePrice, discountPercent: regularPrice > 0 && salePrice != null ? ((regularPrice - salePrice) / regularPrice) * 100 : null,
    imageUrl: value.imageUrl || null, productUrl: value.productUrl || null, fulfillment: value.fulfillment || null,
    availability: value.availability || 'unknown', locationText: value.locationText || null, purchasePopularity: value.purchasePopularity || null,
    dealType: value.dealType || null, source: value.source, sourceType: value.sourceType || null, providerStatus: value.providerStatus || 'ok', fetchedAt: new Date().toISOString()
  };
}

function providerResult(retailer, status, deals, source, error = null) {
  return { retailer, status, deals, count: deals.length, source, error, fetchedAt: new Date().toISOString() };
}

function extractScriptById(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(html).match(new RegExp(`<script[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i'))?.[1] || null;
}

function extractAssignedJson(html, marker) {
  const start = String(html).indexOf(marker);
  if (start < 0) return null;
  const objectStart = String(html).indexOf('{', start + marker.length);
  if (objectStart < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let index = objectStart; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return html.slice(objectStart, index + 1);
  }
  return null;
}

function extractJsonLd(html) {
  return [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(match => { try { return [JSON.parse(match[1])]; } catch { return []; } });
}

function hasTargetStructuredProducts(html) {
  return extractJsonLd(html).flatMap(flattenJsonLd).some(item => item?.['@type'] === 'Product');
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== 'object') return [];
  return [value, ...flattenJsonLd(value['@graph'] || [])];
}

function modelFromHomeDepotUrl(url) {
  const productSlug = String(url || '').split('/').filter(Boolean).at(-2) || '';
  return productSlug.split('-').at(-1) || null;
}

function priceNumber(value) { return finiteNumber(String(value || '').replace(/[^0-9.-]/g, '')); }
function finiteNumber(value) { const number = Number(value); return value !== '' && value != null && Number.isFinite(number) ? number : null; }
function digits(value) { const result = String(value || '').replace(/\D/g, ''); return result.length >= 8 && result.length <= 14 ? result : null; }
function absoluteUrl(origin, path) { if (!path) return null; try { return new URL(path, origin).toString(); } catch { return null; } }
function availabilityValue(value) { const text = String(value || '').toLowerCase(); if (/in.?stock|available/.test(text)) return 'in_stock'; if (/out.?of.?stock|unavailable/.test(text)) return 'out_of_stock'; return 'unknown'; }
function stableId(value) { let hash = 2166136261; for (const char of String(value || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `deal_${(hash >>> 0).toString(36)}`; }
function byDiscountDescending(a, b) { return (b.discountPercent || 0) - (a.discountPercent || 0); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class ProviderUnavailableError extends Error {}
