import { parseTargetEmbeddedState, parseTargetHtmlCards, parseTargetJsonLd,
  parseWalmartNextData, parseWalmartEmbeddedState, parseWalmartHtmlCards, parseWalmartJsonLd,
  parseKohlsEmbeddedState, parseKohlsHtmlCards, parseKohlsJsonLd,
  runParserCandidates, explicitEmptyWalmart } from './public-retail-parsers.mjs';
const RETAILER_CACHE_TTL_MS = 10 * 60 * 1000;
const RETAILER_TIMEOUT_MS = 15_000;
const MAX_DEALS_PER_PROVIDER = 40;
const RETAILER_CACHE = new Map();
const RETAILER_HEALTH = new Map();
const PARSERS = {
  Target: [parseTargetEmbeddedState, parseTargetHtmlCards, parseTargetJsonLd],
  Walmart: [parseWalmartNextData, parseWalmartEmbeddedState, parseWalmartHtmlCards, parseWalmartJsonLd],
  "Kohl's": [parseKohlsEmbeddedState, parseKohlsHtmlCards, parseKohlsJsonLd]
};

async function listPublicDeals(provider) {
  return cachedProviderResult(provider.name, provider.url, async () => {
    const html = await fetchRetailerHtml(provider.url, provider.fetcher);
    const parsed = runParserCandidates(html, PARSERS[provider.name]);
    const deals = dedupeDeals(parsed.deals).sort(byDiscountDescending).slice(0, MAX_DEALS_PER_PROVIDER);
    const empty = provider.name === 'Walmart' && explicitEmptyWalmart(html);
    const result = providerResult(provider.name, deals.length ? 'ok' : empty ? 'empty' : 'unavailable', deals,
      provider.source, !deals.length && !empty ? 'No validated public product data; no private endpoints used' : null);
    return { ...result, httpStatus: 200, parserDiagnostics: parsed.diagnostics,
      failureType: deals.length || empty ? null : parsed.diagnostics.some(x => x.status === 'parse_error') ? 'parse_error' : 'no_public_products' };
  });
}

export class WalmartDealProvider {
  constructor(options = {}) {
    this.name = 'Walmart';
    this.source = 'walmart_public_clearance';
    this.mock = false;
    this.url = 'https://www.walmart.com/shop/deals/clearance';
    this.fetcher = options.fetcher || fetch;
  }

  async listDeals() {
    return listPublicDeals(this);
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
    return listPublicDeals(this);
  }
}

export class KohlsDealProvider {
  constructor(options = {}) {
    this.name = "Kohl's"; this.source = 'kohls_clearance'; this.mock = false;
    this.url = 'https://www.kohls.com/catalog/clearance.jsp?CN=Promotions%3AClearance';
    this.fetcher = options.fetcher || fetch;
  }
  async listDeals() { return listPublicDeals(this); }
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
  const result = runParserCandidates(html, PARSERS.Walmart);
  if (!result.deals.length && !explicitEmptyWalmart(html)) throw new ProviderUnavailableError('Walmart __NEXT_DATA__ / public product data unavailable');
  return dedupeDeals(result.deals).sort(byDiscountDescending);
}

export function parseTargetDeals(html) {
  return dedupeDeals(runParserCandidates(html, PARSERS.Target).deals).sort(byDiscountDescending);
}

export function parseKohlsDeals(html) { return dedupeDeals(runParserCandidates(html, PARSERS["Kohl's"]).deals).sort(byDiscountDescending); }
export const RETAILER_PROVIDERS = [WalmartDealProvider, TargetDealProvider, HomeDepotDealProvider, KohlsDealProvider];

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
  if (!(Number.isFinite(salePrice) && regularPrice > salePrice && salePrice >= 0)) return null;
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
  if (!(Number.isFinite(salePrice) && regularPrice > salePrice && salePrice >= 0)) return null;
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
  if (!(Number.isFinite(salePrice) && regularPrice > salePrice && salePrice >= 0)) return null;
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
    availability: item.availabilityType?.buyable === true ? 'in_stock' : availabilityValue(item.availabilityType?.status),
    dealType: promotion.savingsCenter || promotion.savingsCenterPromos || 'Daily Deal',
    source: 'homedepot_daily_deals', sourceType: 'daily_deal', providerStatus: 'ok'
  });
}

export function dedupeDeals(deals) {
  const seen = new Set();
  return deals.filter(deal => {
    let url = deal.productUrl;
    try { const parsed = new URL(url); parsed.hash = ''; for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|ath|ref$)/i.test(key)) parsed.searchParams.delete(key); url = parsed.toString(); } catch { /* Identity fallbacks below. */ }
    const identity = digits(deal.upc) || digits(deal.gtin) || deal.sku || deal.productId || url
      || (deal.brand && deal.model ? `${deal.brand}|${deal.model}` : deal.title || deal.id);
    const key = `${deal.retailer}|${identity}`.toLowerCase().trim().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function clearRetailerCacheForTests() {
  RETAILER_CACHE.clear();
  RETAILER_HEALTH.clear();
}

async function cachedProviderResult(name, url, loader) {
  const cacheKey = `${name}|${url}`;
  const cached = RETAILER_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cache: 'hit' };
  try {
    const value = await loader();
    const health = updateHealth(name, value);
    const result = { ...value, health };
    RETAILER_CACHE.set(cacheKey, { expiresAt: Date.now() + (value.status === 'unavailable' ? 60000 : RETAILER_CACHE_TTL_MS), value: result });
    return { ...result, cache: 'miss' };
  } catch (error) {
    const status = error instanceof ProviderUnavailableError ? 'unavailable' : 'error';
    const value = { ...providerResult(name, status, [], null, error instanceof SyntaxError ? 'Public structured data parse error' : error?.message || 'Retailer fetch failed'),
      httpStatus: error.httpStatus || null, failureType: error.failureType || (error instanceof SyntaxError ? 'parse_error' : 'fetch_error') };
    value.health = updateHealth(name, value);
    RETAILER_CACHE.set(cacheKey, { expiresAt: Date.now() + 60000, value });
    return { ...value, cache: 'miss' };
  }
}

async function fetchRetailerHtml(url, fetcher) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RETAILER_TIMEOUT_MS);
    try {
      const response = await fetcher(url, { headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'ResaleScanner/2.6.4 (+https://github.com/Norisss1114/resale-scanner)' }, signal: controller.signal });
      if ([403, 429].includes(response.status)) throw Object.assign(new ProviderUnavailableError(`HTTP ${response.status}; no bypass attempted`), { httpStatus: response.status, failureType: String(response.status) });
      const html = await readBoundedHtml(response);
      if (response.ok) {
        if (!html.trim() || /<title[^>]*>\s*(?:Access Denied|Robot or human|Just a moment|Captcha)|verify (?:that )?you are (?:a )?human|press and hold to confirm/i.test(html)) throw Object.assign(new ProviderUnavailableError('Empty or anti-bot response; no bypass attempted'), { httpStatus: response.status, failureType: 'blocked_or_empty' });
        if (html.length > 6_000_000) throw new ProviderUnavailableError('Public page exceeds size limit');
        return html;
      }
      if (response.status >= 500 && attempt < 1) {
        const retryAfter = Math.min(5, Math.max(1, Number(response.headers.get('retry-after')) || 2 ** attempt));
        await delay(retryAfter * 1000);
        continue;
      }
      throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status });
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderUnavailableError) throw error;
      if (error?.name === 'AbortError') lastError = Object.assign(new ProviderUnavailableError('timeout'), { failureType: 'timeout' });
      if (attempt < 1) { await delay((2 ** attempt) * 500); continue; }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Retailer request failed');
}

async function readBoundedHtml(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder(); let total = 0, html = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return html + decoder.decode();
    total += value.byteLength;
    if (total > 6_000_000) { await reader.cancel(); throw new ProviderUnavailableError('Public page exceeds size limit'); }
    html += decoder.decode(value, { stream: true });
  }
}

function normalizedDeal(value) {
  if (!String(value.title || '').trim() || !value.productUrl) return null;
  const regularPrice = finiteNumber(value.regularPrice);
  const salePrice = finiteNumber(value.salePrice);
  return {
    id: value.id || stableId(`${value.retailer}|${value.productUrl}|${value.title}`), retailer: value.retailer || null,
    title: value.title || 'Untitled deal', brand: value.brand || null, model: value.model || null, upc: digits(value.upc), gtin: digits(value.gtin), sku: value.sku || null,
    regularPrice, salePrice, discountPercent: regularPrice > 0 && salePrice != null ? ((regularPrice - salePrice) / regularPrice) * 100 : null,
    currentPrice: salePrice, referencePrice: regularPrice, referencePriceType: regularPrice == null ? null : 'original',
    parserSource: value.retailer === 'Home Depot' ? 'apollo_state' : 'legacy_state',
    dataQuality: regularPrice != null && value.sku ? 'Medium' : 'Low', sourceConfidence: 'High',
    imageUrl: value.imageUrl || null, productUrl: value.productUrl || null, fulfillment: value.fulfillment || null,
    availability: value.availability || 'unknown', locationText: value.locationText || null, purchasePopularity: value.purchasePopularity || null,
    dealType: value.dealType || null, source: value.source, sourceType: value.sourceType || null, providerStatus: value.providerStatus || 'ok', fetchedAt: new Date().toISOString()
  };
}

function providerResult(retailer, status, deals, source, error = null) {
  return { retailer, status, deals, count: deals.length, source, error, httpStatus: status === 'ok' || status === 'empty' ? 200 : null, fetchedAt: new Date().toISOString() };
}

function updateHealth(name, result) {
  const prior = RETAILER_HEALTH.get(name) || { success: 0, unavailable: 0, error: 0, lastSuccess: null, lastFailure: null };
  const success = ['ok', 'empty'].includes(result.status);
  const key = success ? 'success' : result.status === 'unavailable' ? 'unavailable' : 'error';
  const health = { ...prior, [key]: prior[key] + 1,
    lastSuccess: success ? result.fetchedAt : prior.lastSuccess,
    lastFailure: success ? prior.lastFailure : result.fetchedAt,
    lastFailureType: success ? prior.lastFailureType || null : result.failureType,
    scope: 'isolate; scheduled results also stored in scan_runs.provider_summary' };
  RETAILER_HEALTH.set(name, health);
  return health;
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
function absoluteUrl(origin, path) { if (!path) return null; try { const url = new URL(path, origin); return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password ? url.toString() : null; } catch { return null; } }
function availabilityValue(value) { const text = String(value || '').toLowerCase(); if (/out.?of.?stock|unavailable/.test(text)) return 'out_of_stock'; if (/in.?stock|^available$/.test(text)) return 'in_stock'; return 'unknown'; }
function stableId(value) { let hash = 2166136261; for (const char of String(value || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `deal_${(hash >>> 0).toString(36)}`; }
function byDiscountDescending(a, b) { return (b.discountPercent || 0) - (a.discountPercent || 0); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class ProviderUnavailableError extends Error {}
