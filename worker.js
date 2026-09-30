import { calculateDealScore, calculateLocalScore, filterDeals, sortDeals } from './lib/deal-utils.mjs';
import { calculateEconomics, buildDecision } from './lib/decision-intelligence.mjs';
import { RETAILER_PROVIDERS, dedupeDeals } from './lib/retailer-providers.mjs';
import { rankCandidates, candidateRequestCapacity } from './lib/candidate-ranking.mjs';
import { HomeDepotStoreProvider, LocationProvider, TargetStoreProvider, WalmartStoreProvider, storesWithinRadius, validateZip } from './lib/location-providers.mjs';
import { compareSnapshots, scanRunStatus, snapshotFromAnalysis } from './lib/monitoring.mjs';
import { acquireScheduledRun, cleanupMonitoring, getLatestScan, getScanHistory, getTodaysOpportunities, markRunFailed, previousSnapshots, saveMonitoringResult } from './lib/scan-persistence.mjs';
import { buildProductSearchPlan, evaluateListingMatch, matchProfile } from './lib/product-matching.mjs';
import { diagnoseProfit, supportsDealScore } from './lib/profit-diagnostics.mjs';
import { createProviderTransport } from './lib/provider-transport.mjs';
import { budgetHealth, providerControls } from './lib/provider-budget.mjs';
import { consumeLimit, issueSession, limitedJson, requireSession, sameOrigin, sessionCookie } from './lib/access.mjs';
import { marketConfidence } from './lib/market-confidence.mjs';

const providerTransport = createProviderTransport();

const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const API_TIMEOUT_MS = 18000;
const LISTINGS_SOURCE = 'eBay Sold Listings API';
const DEAL_ANALYSIS_CONCURRENCY = 1;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') sameOrigin(request);
      if (url.pathname === '/api/session' && request.method === 'POST') {
        await consumeLimit(env, 'session-attempts', 5, 15 * 60000);
        const body = await limitedJson(request, 1024);
        const token = await issueSession(env, body.password);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': sessionCookie(token) } });
      }
      await requireSession(request, env);
      if (url.pathname === '/api/session' && request.method === 'GET') return json({ ok: true });
      if (url.pathname === '/api/provider/health' && request.method === 'GET') return json(await budgetHealth(env));
      if (request.method === 'POST') await consumeLimit(env, 'manual-api-minute', 20, 60000);
    }

    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        assertConfigured(env);
        const body = await readJson(request);
        validateImage(body.productImage);
        await consumeLimit(env, 'openai-daily', 20, 86400000);

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

        return json(analyzeMarketAndProfit({ identified, searchPlan, activeResult, soldResult, body, fetchedAt }));
      } catch (e) {
        return json({ error: e?.message || String(e), status: 'API unavailable' }, e?.status || 500);
      }
    }

    if (url.pathname === '/api/deals/scan' && request.method === 'POST') {
      try {
        assertListingsConfigured(env);
        const body = await readJson(request);
        return json(publicScanResult(await runDealScanService(env, body, { triggerType: 'manual' })));
      } catch (e) {
        return json({ error: e?.message || String(e), status: 'DEAL_PROVIDER_FAILURE' }, e?.status || 500);
      }
    }

    if (url.pathname === '/api/location' && request.method === 'POST') {
      const body = await readJson(request);
      const radiusMiles = normalizeRadius(body.radiusMiles);
      return json(await discoverLocal(body.zipCode, radiusMiles));
    }

    if (url.pathname === '/api/opportunities/today' && request.method === 'GET') return json(await getTodaysOpportunities(env));
    if (url.pathname === '/api/scans/history' && request.method === 'GET') return json(await getScanHistory(env, url.searchParams.get('limit')));
    if (url.pathname === '/api/scans/latest' && request.method === 'GET') return json(await getLatestScan(env));

    return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error.status ? error.message : 'Service unavailable; check configuration and migrations' }, error.status || 503);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledScan(env, { scheduledTime: event.scheduledTime }));
  }
};

export async function runDealScanService(env, body = {}, options = {}) {
  assertListingsConfigured(env);
  const scheduled = options.triggerType === 'scheduled';
  const radiusMiles = normalizeRadius(body.location?.radiusMiles);
  const locationPromise = discoverLocal(body.location?.zipCode, radiusMiles);
  const providers = createDealProviders(body.source, scheduled);
  const listingsProvider = createListingsProvider(env, scheduled ? 'scheduled' : 'manual');
  const budget = await budgetHealth(env, scheduled ? 'scheduled' : 'manual');
  const [settledProviders, local] = await Promise.all([
    Promise.allSettled(providers.map(provider => provider.listDeals())),
    locationPromise
  ]);
  const providerStatuses = settledProviders.map((settled, index) => settled.status === 'fulfilled'
    ? settled.value
    : { retailer: providers[index].name, status: 'error', deals: [], count: 0, source: providers[index].source, error: settled.reason?.message || String(settled.reason), fetchedAt: new Date().toISOString() });
  const allDeals = dedupeDeals(providerStatuses.flatMap(provider => provider.deals || []))
    .map(deal => addLocalDealData(deal, local, radiusMiles));
  const selection = rankCandidates(allDeals, { remaining: candidateRequestCapacity(budget), scheduled });
  const candidates = selection.selected;
  const analyzed = await mapWithConcurrency(candidates, DEAL_ANALYSIS_CONCURRENCY, deal => analyzeDeal(deal, listingsProvider));
  const successful = analyzed.filter(item => item.status === 'OK' || item.status === 'PARTIAL');
  const filtered = filterDeals(successful, body.filters);
  const visibleIds = new Set(filtered.map(item => item.deal.id));
  const sorted = sortDeals(analyzed.filter(item => !['OK', 'PARTIAL'].includes(item.status) || visibleIds.has(item.deal.id)), body.sortBy);
  const verdictCounts = countDealVerdicts(successful);
  return {
    version: '2.6.4', source: body.source === 'mock' ? 'mock' : 'live', triggerType: options.triggerType || 'manual',
    providers: providerStatuses.map(({ deals: ignored, ...provider }) => provider),
    location: local.location, storeProviders: local.storeProviders, nearbyStores: local.nearbyStores,
    capabilities: retailerCapabilities(providerStatuses, local.storeProviders),
    providerHealth: await budgetHealth(env, scheduled ? 'scheduled' : 'manual'),
    budgetSkipped: selection.deferred,
    candidateSelection: { eligible: selection.eligibleCount, selected: candidates.length, deferred: selection.deferred, maxAnalyses: 8, maxPerRetailer: 4 },
    counts: {
      fetched: allDeals.length, candidates: candidates.length, analyzed: successful.length, matchedFilters: filtered.length, errors: analyzed.length - successful.length,
      profitable: successful.filter(item => item.profitStatus === 'PROFITABLE').length,
      unprofitable: successful.filter(item => item.profitStatus === 'UNPROFITABLE').length,
      noData: successful.filter(item => ['NO_SOLD_DATA', 'NO_ACTIVE_DATA', 'NO_MARKET_DATA', 'INSUFFICIENT_PRICE_DATA'].includes(item.profitStatus)).length,
      lowMatch: successful.filter(item => item.profitStatus === 'LOW_MATCH_CONFIDENCE').length,
      providerErrors: successful.filter(item => item.profitStatus === 'PROVIDER_ERROR').length,
      buy: verdictCounts.BUY, maybe: verdictCounts.MAYBE, skip: verdictCounts.SKIP,
      potentialProfit: successful.some(item => supportsDealScore(item.profitStatus) && Number.isFinite(item.analysis?.profit?.netProfit))
        ? successful.reduce((sum, item) => item.profitStatus === 'PROFITABLE' && Number.isFinite(item.analysis?.profit?.netProfit) ? sum + item.analysis.profit.netProfit : sum, 0) : null
    },
    filters: normalizeDealFilters(body.filters), sortBy: body.sortBy || 'dealScore', deals: sorted,
    allDeals, analyzedItems: analyzed, fetchedAt: new Date().toISOString()
  };
}

export async function runScheduledScan(env, options = {}) {
  const now = new Date(options.scheduledTime || Date.now());
  const lock = await acquireScheduledRun(env, now);
  if (!lock.acquired) return { status: 'skipped', reason: lock.reason, runId: lock.runId || null };
  try {
    const result = await (options.scanService || runDealScanService)(env, {
      source: 'live', location: { zipCode: env.SCAN_ZIP_CODE || '', radiusMiles: env.SCAN_RADIUS_MILES || 15 },
      filters: { minimumProfit: 20, minimumRoi: 30, minimumDiscount: 0 }, sortBy: 'dealScore'
    }, { triggerType: 'scheduled' });
    const previous = await previousSnapshots(env, lock.runId);
    const analyzedById = new Map(result.analyzedItems.map(item => [item.deal.id, item]));
    const detectedAt = new Date().toISOString();
    const snapshots = result.allDeals.map(deal => snapshotFromAnalysis(analyzedById.get(deal.id) || { deal }, lock.runId, detectedAt));
    const events = compareSnapshots(snapshots, previous.snapshots, previous.historicalKeys);
    const errorCount = result.counts.errors + (result.counts.providerErrors || 0);
    const status = result.budgetSkipped > 0 && result.counts.analyzed === 0 ? 'skipped'
      : scanRunStatus({ providerStatuses: result.providers, analyzed: result.counts.analyzed, errors: errorCount + (result.budgetSkipped || 0) });
    const run = {
      id: lock.runId, completedAt: detectedAt, status, totalDeals: result.counts.fetched, analyzedDeals: result.counts.analyzed,
      buyCount: result.counts.buy, maybeCount: result.counts.maybe, skipCount: result.counts.skip,
      newCount: events.filter(item => item.eventType === 'new_deal').length,
      priceDropCount: events.filter(item => item.eventType === 'price_drop').length,
      errorCount, providerSummary: [...result.providers, ...(result.budgetSkipped ? [{ retailer: 'Candidate limits / eBay budget', status: 'deferred', count: result.budgetSkipped }] : [])]
    };
    await saveMonitoringResult(env, run, snapshots, events);
    await cleanupMonitoring(env, now);
    return { status, runId: lock.runId, snapshots: snapshots.length, events: events.length };
  } catch (error) {
    await markRunFailed(env, lock.runId, error);
    throw error;
  }
}

function publicScanResult(result) {
  const { allDeals: ignoredDeals, analyzedItems: ignoredItems, ...publicResult } = result;
  return publicResult;
}

function assertConfigured(env) {
  if (!env.OPENAI_API_KEY) throw withStatus('OPENAI_API_KEY が設定されていません', 500);
  assertListingsConfigured(env);
}

function assertListingsConfigured(env) {
  if (!env.EBAY_SOLD_API_URL || !env.EBAY_SOLD_API_KEY) {
    throw withStatus('EBAY_SOLD_API_URL / EBAY_SOLD_API_KEY が設定されていません', 500);
  }
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
  return buildProductSearchPlan(p);
}

function createDealProviders(source, scheduled = false) {
  if (source === 'mock') return [new MockDealProvider()];
  if (!source || source === 'live') return RETAILER_PROVIDERS.map(Provider => new Provider());
  throw withStatus(`未対応のDeal sourceです: ${source}`, 400);
}

async function discoverLocal(zipCode, radiusMiles) {
  const zip = clean(zipCode);
  if (!zip) return { location: { status: 'not_set', location_status: 'not_set', radiusMiles, message: 'Location not set' }, storeProviders: [], nearbyStores: [] };
  if (!validateZip(zip)) return { location: { status: 'invalid', location_status: 'unavailable', zipCode: zip, radiusMiles, error: 'ZIP Code must be 5 digits' }, storeProviders: [], nearbyStores: [] };
  const locationProvider = new LocationProvider();
  const location = await locationProvider.locate(zip);
  if (location.status !== 'ok') return { location: { ...location, radiusMiles }, storeProviders: [], nearbyStores: [] };
  const providers = [new WalmartStoreProvider({ locationProvider }), new TargetStoreProvider({ locationProvider }), new HomeDepotStoreProvider({ locationProvider })];
  const settled = await Promise.allSettled(providers.map(provider => provider.listStores(location)));
  const storeProviders = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { retailer: providers[index].name, status: 'error', count: 0, source: providers[index].source, error: result.reason?.message || String(result.reason) });
  const nearbyStores = storesWithinRadius(storeProviders.flatMap(provider => provider.stores || []), radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 10);
  return {
    location: { ...location, radiusMiles },
    storeProviders: storeProviders.map(({ stores: ignored, ...provider }) => provider),
    nearbyStores
  };
}

function addLocalDealData(deal, local, radiusMiles) {
  const fulfillment = String(deal.fulfillment || '').toLowerCase();
  const pickupAvailable = /pickup|pick up|curbside|drive.?up/.test(fulfillment) ? true : null;
  const shippingAvailable = /shipping|delivery|ship/.test(fulfillment) ? true : null;
  const nearest = local.nearbyStores?.filter(store => store.retailer === deal.retailer).sort((a, b) => a.distanceMiles - b.distanceMiles)[0] || null;
  const provider = local.storeProviders?.find(entry => entry.retailer === deal.retailer);
  const providerUnavailable = local.location?.status === 'ok' && provider && ['unavailable', 'error'].includes(provider.status);
  const localAvailabilityStatus = providerUnavailable ? 'unavailable' : pickupAvailable === true ? 'likely' : 'unknown';
  const availabilityType = pickupAvailable === true ? 'pickup' : shippingAvailable === true ? 'shipping' : deal.availability === 'in_stock' ? 'online' : 'unknown';
  return {
    ...deal,
    radiusMiles,
    storeId: nearest?.id || null,
    storeName: nearest?.name || null,
    storeDistanceMiles: nearest?.distanceMiles ?? null,
    withinRadius: nearest != null && nearest.distanceMiles <= radiusMiles,
    availabilityType,
    localAvailabilityStatus,
    pickupAvailable,
    shippingAvailable,
    inventoryCount: null
  };
}

function retailerCapabilities(dealProviders, storeProviders) {
  return [...new Set(dealProviders.map(p => p.retailer))].map(retailer => {
    const deals = dealProviders.find(provider => provider.retailer === retailer);
    const stores = storeProviders.find(provider => provider.retailer === retailer);
    return {
      retailer,
      deals: deals?.status === 'ok' ? 'supported' : deals?.status || 'unavailable',
      price: fieldCapability(deals, 'salePrice'),
      originalPrice: fieldCapability(deals, 'regularPrice'),
      model: fieldCapability(deals, 'model'),
      brand: fieldCapability(deals, 'brand'),
      parserSources: [...new Set((deals?.deals || []).map(d => d.parserSource).filter(Boolean))],
      stores: stores?.status === 'ok' ? 'supported' : stores?.status || 'not_checked',
      pickup: deals?.deals?.some(deal => /pickup|curbside|drive.?up/i.test(deal.fulfillment || '')) ? 'partial' : 'unavailable',
      storeInventory: 'unavailable'
    };
  });
}

function fieldCapability(provider, field) {
  const deals = provider?.deals || [];
  const count = deals.filter(d => d[field] != null && d[field] !== '').length;
  return !deals.length ? 'unavailable' : count === deals.length ? 'supported' : count ? 'partial' : 'unavailable';
}

function normalizeRadius(value) {
  const allowed = [5, 10, 15, 25, 50];
  const radius = Number(value);
  return allowed.includes(radius) ? radius : 15;
}

class MockDealProvider {
  constructor() {
    this.name = 'Mock Multi-Retailer Provider';
    this.source = 'mock';
    this.mock = true;
  }

  async listDeals() {
    const deals = MOCK_DEALS.map(normalizeDeal);
    return { retailer: 'Mock', status: deals.length ? 'ok' : 'empty', deals, count: deals.length, source: this.source, error: null, fetchedAt: new Date().toISOString() };
  }
}

const MOCK_DEALS = [
  {
    id: 'deal_hd_dewalt_dcd771c2', retailer: 'Home Depot', title: 'DEWALT 20V MAX Cordless Drill Driver Kit DCD771C2', brand: 'DEWALT', model: 'DCD771C2', upc: '885911325905', sku: 'DCD771C2', regularPrice: 179, salePrice: 59, imageUrl: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?auto=format&fit=crop&w=900&q=80', productUrl: 'https://www.homedepot.com/s/DCD771C2', fulfillment: 'pickup', availability: 'in_stock', category: 'Power Tools', packedWeightLb: 5.2
  },
  {
    id: 'deal_target_ninja_bl610', retailer: 'Target', title: 'Ninja Professional Blender 1000W BL610', brand: 'Ninja', model: 'BL610', upc: '622356536820', sku: 'BL610', regularPrice: 109.99, salePrice: 54.99, imageUrl: 'https://images.unsplash.com/photo-1570222094114-d054a817e56b?auto=format&fit=crop&w=900&q=80', productUrl: 'https://www.target.com/s?searchTerm=Ninja+BL610', fulfillment: 'shipping', availability: 'in_stock', category: 'Small Kitchen Appliances', packedWeightLb: 9
  },
  {
    id: 'deal_walmart_airtag_4', retailer: 'Walmart', title: 'Apple AirTag 4 Pack MX542AM/A', brand: 'Apple', model: 'MX542AM/A', upc: '194252502000', sku: 'MX542AM/A', regularPrice: 99, salePrice: 74, imageUrl: 'https://images.unsplash.com/photo-1606741965509-116b4d21f4cf?auto=format&fit=crop&w=900&q=80', productUrl: 'https://www.walmart.com/search?q=Apple+AirTag+4+Pack', fulfillment: 'shipping', availability: 'in_stock', category: 'Electronics', packedWeightLb: 0.5
  },
  {
    id: 'deal_target_lego_75379', retailer: 'Target', title: 'LEGO Star Wars R2-D2 Building Set 75379', brand: 'LEGO', model: '75379', upc: '673419389624', sku: '75379', regularPrice: 99.99, salePrice: 69.99, imageUrl: 'https://images.unsplash.com/photo-1587654780291-39c9404d746b?auto=format&fit=crop&w=900&q=80', productUrl: 'https://www.target.com/s?searchTerm=LEGO+75379', fulfillment: 'pickup', availability: 'limited', category: 'Toys', packedWeightLb: 4
  },
  {
    id: 'deal_walmart_hypertough', retailer: 'Walmart', title: 'Hyper Tough 20V Cordless Drill AQ75034G', brand: 'Hyper Tough', model: 'AQ75034G', upc: '820909750343', sku: 'AQ75034G', regularPrice: 48.88, salePrice: 29, imageUrl: 'https://images.unsplash.com/photo-1572981779307-38b8cabb2407?auto=format&fit=crop&w=900&q=80', productUrl: 'https://www.walmart.com/search?q=Hyper+Tough+AQ75034G', fulfillment: 'pickup', availability: 'in_stock', category: 'Power Tools', packedWeightLb: 4.5
  },
  {
    id: 'deal_hd_mock_zxq9999', retailer: 'Home Depot', title: 'Mock Clearance Workshop Widget ZXQ-9999', brand: 'MockWorks', model: 'ZXQ-9999', upc: null, sku: 'ZXQ-9999', regularPrice: 149, salePrice: 19, imageUrl: 'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?auto=format&fit=crop&w=900&q=80', productUrl: 'https://www.homedepot.com/', fulfillment: 'pickup', availability: 'in_stock', category: 'Tools', packedWeightLb: 3
  }
];

function normalizeDeal(raw) {
  const regularPrice = nullableNumber(raw.regularPrice);
  const salePrice = nullableNumber(raw.salePrice);
  const discountPercent = regularPrice > 0 && salePrice != null ? ((regularPrice - salePrice) / regularPrice) * 100 : null;
  return {
    id: clean(raw.id) || crypto.randomUUID(),
    retailer: clean(raw.retailer) || null,
    title: clean(raw.title) || 'Untitled deal',
    brand: clean(raw.brand) || null,
    model: clean(raw.model) || null,
    upc: normalizeDigits(raw.upc),
    gtin: normalizeDigits(raw.gtin),
    sku: clean(raw.sku) || null,
    regularPrice,
    salePrice,
    discountPercent,
    imageUrl: clean(raw.imageUrl) || null,
    productUrl: clean(raw.productUrl) || null,
    fulfillment: clean(raw.fulfillment) || null,
    availability: clean(raw.availability) || null,
    locationText: clean(raw.locationText) || null,
    category: clean(raw.category) || null,
    packedWeightLb: nullableNumber(raw.packedWeightLb),
    purchasePopularity: clean(raw.purchasePopularity) || null,
    dealType: clean(raw.dealType) || null,
    source: raw.source || 'mock',
    sourceType: raw.sourceType || 'mock',
    providerStatus: raw.providerStatus || 'ok',
    fetchedAt: raw.fetchedAt || new Date().toISOString()
  };
}

async function analyzeDeal(deal, listingsProvider) {
  try {
    const identified = dealToNormalizedProduct(deal);
    const searchPlan = buildSearchPlan(identified);
    const fetchedAt = new Date();
    const [activeResult, soldResult] = await Promise.all([
      listingsProvider.search(searchPlan, identified, false),
      listingsProvider.search(searchPlan, identified, true)
    ]);
    const analysis = analyzeMarketAndProfit({
      identified,
      searchPlan,
      activeResult,
      soldResult,
      body: { cost: deal.salePrice, packaging: 0.5, promotedRate: 0, perOrderFee: 0.4 },
      fetchedAt
    });
    const matchingConfidence = analysis.matchingConfidence;
    const diagnosis = diagnoseProfit({ soldResult, activeResult, analysis, matchingConfidence });
    if (!supportsDealScore(diagnosis.profitStatus)) {
      analysis.profit.netProfit = null;
      analysis.profit.roi = null;
    }
    const dealScore = supportsDealScore(diagnosis.profitStatus) ? calculateDealScore({
      estimatedProfit: analysis.profit.netProfit,
      roi: analysis.profit.roi,
      sold90: analysis.sold.count90d,
      sellThrough: analysis.market.sellThrough90d,
      discountPercent: deal.discountPercent,
      activeCount: analysis.active.count
    }) : null;
    const localScore = calculateLocalScore({ distanceMiles: deal.storeDistanceMiles, radiusMiles: deal.radiusMiles || 15, pickupAvailable: deal.pickupAvailable, localAvailabilityStatus: deal.localAvailabilityStatus });
    const verdict = dealScore
      ? analysis.verdict
      : { label: 'MAYBE', reasons: [diagnosis.profitReason, ...analysis.marketConfidence.reasons], badge: diagnosis.reasonBadge || 'VERIFY MATCH' };
    const diagnostics = {
      searchQuery: searchPlan.primary, searchStrategy: searchPlan.strategy,
      matchMethod: matchingConfidence.matchMethod, matchReason: matchingConfidence.matchReason,
      soldMatchCount: soldResult.ok ? soldResult.total : null, activeMatchCount: activeResult.ok ? activeResult.total : null,
      soldSourceCount: soldResult.source_total ?? null, activeSourceCount: activeResult.source_total ?? null,
      soldProviderStatus: soldResult.ok ? 'ok' : 'error', activeProviderStatus: activeResult.ok ? 'ok' : 'error'
    };
    return {
      status: analysis.status,
      errorType: analysis.status === 'DATA_UNAVAILABLE' ? 'EBAY_PROVIDER_FAILURE' : analysis.status === 'PARTIAL' ? 'EBAY_PROVIDER_PARTIAL_FAILURE' : null,
      deal,
      dealScore,
      localScore,
      matchingConfidence,
      marketConfidence: analysis.marketConfidence,
      matchEvidence: analysis.matchEvidence,
      verdict,
      ...diagnosis,
      matchMethod: matchingConfidence.matchMethod,
      matchReason: matchingConfidence.matchReason,
      diagnostics,
      analysis,
      sources: { deal: deal.source === 'mock' ? 'Mock Deal Provider' : `${deal.retailer} Live Provider`, ebay: LISTINGS_SOURCE }
    };
  } catch (e) {
    return { status: 'ERROR', deal, errorType: 'ANALYSIS_FAILURE', error: e?.message || String(e), profitStatus: 'ANALYSIS_ERROR', profitReason: 'Deal analysis failed before profit could be calculated.', marketDataStatus: 'PROVIDER_ERROR', matchMethod: null, matchReason: 'Match analysis did not complete.', diagnostics: { error: e?.message || String(e) }, verdict: { label: 'MAYBE', badge: 'API ERROR', reasons: ['Deal analysis failed'] }, sources: { deal: deal.source === 'mock' ? 'Mock Deal Provider' : `${deal.retailer} Live Provider`, ebay: LISTINGS_SOURCE } };
  }
}

function dealToNormalizedProduct(deal) {
  return {
    brand: deal.brand,
    product_name: deal.title,
    model: deal.model,
    upc_gtin_ean: deal.upc || deal.gtin,
    size: null,
    color: null,
    category: deal.category,
    specifications: [deal.fulfillment, deal.availability].filter(Boolean),
    condition: 'New',
    observed_price: deal.salePrice,
    search_keywords: [deal.brand, deal.model, deal.title].filter(Boolean).join(' '),
    packed_weight_lb: deal.packedWeightLb,
    packed_length_in: null,
    packed_width_in: null,
    packed_height_in: null,
    shipping_estimate_confidence: deal.packedWeightLb ? 'Medium' : 'Low',
    match_confidence: 'Low',
    identification_notes: `Normalized from ${deal.retailer} ${deal.sourceType || 'public'} deal`
  };
}

function normalizeDealFilters(filters = {}) {
  return {
    minimumProfit: nullableNumber(filters.minimumProfit) ?? 25,
    minimumRoi: nullableNumber(filters.minimumRoi) ?? 40,
    minimumDiscount: nullableNumber(filters.minimumDiscount) ?? 0,
    retailer: clean(filters.retailer) || 'all',
    sourceType: clean(filters.sourceType) || 'all',
    verdict: clean(filters.verdict) || 'all',
    inStockOnly: filters.inStockOnly === true || filters.inStockOnly === 'true',
    withinRadiusOnly: filters.withinRadiusOnly === true || filters.withinRadiusOnly === 'true',
    pickupOnly: filters.pickupOnly === true || filters.pickupOnly === 'true',
    confirmedOnly: filters.confirmedOnly === true || filters.confirmedOnly === 'true'
  };
}

function countDealVerdicts(items) {
  return items.reduce((counts, item) => {
    const label = item.verdict?.label;
    if (label in counts) counts[label] += 1;
    return counts;
  }, { BUY: 0, MAYBE: 0, SKIP: 0 });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const [settled] = await Promise.allSettled([mapper(items[index], index)]);
      results[index] = settled.status === 'fulfilled'
        ? settled.value
        : { status: 'ERROR', deal: items[index], errorType: 'ANALYSIS_FAILURE', error: settled.reason?.message || String(settled.reason) };
    }
  });
  await Promise.all(workers);
  return results;
}

function createListingsProvider(env, priority = 'product') {
  return new EbaySoldListingsProvider(env, priority);
}

class EbaySoldListingsProvider {
  constructor(env, priority) {
    this.url = env.EBAY_SOLD_API_URL;
    this.key = env.EBAY_SOLD_API_KEY;
    this.controls = providerControls(env, priority);
    this.cache = new Map();
  }

  search(searchPlan, identified, sold) {
    const cacheKey = JSON.stringify([sold, searchPlan.primary, identified]);
    if (!this.cache.has(cacheKey)) this.cache.set(cacheKey, this.searchUncached(searchPlan, identified, sold));
    return this.cache.get(cacheKey);
  }

  async searchUncached(searchPlan, identified, sold) {
    const kind = sold ? 'Sold' : 'Active';
    try {
      const url = new URL(this.url);
      url.searchParams.set('keyword', searchPlan.primary);
      url.searchParams.set('sold', String(sold));
      url.searchParams.set('count', '240');
      url.searchParams.set('itemCondition', providerCondition(identified.condition));

      const data = await providerTransport.request(url, this.key, this.controls);
      if (!Array.isArray(data.results)) throw new Error(`${kind} Provider returned an invalid response`);

      const evaluated = data.results
        .map(item => normalizeProviderListing(item, sold))
        .map(item => ({ item, match: evaluateListingMatch(item, identified) }));
      const listings = evaluated
        .filter(entry => entry.match.matched)
        .map(entry => ({ ...entry.item, matchMethod: entry.match.matchMethod, matchReason: entry.match.matchReason, matchEvidence: entry.match.matchEvidence }));
      return {
        ok: true,
        source: LISTINGS_SOURCE,
        query: searchPlan.primary,
        total: listings.length,
        source_total: Number.isInteger(data.count) ? data.count : data.results.length,
        listings,
        rejectedEvidence: evaluated.filter(entry => !entry.match.matched).slice(0, 10).map(entry => entry.match),
        sampleCapped: data.results.length >= 240 || Number(data.count) >= 240,
        fetched_at: data.retrievedAt
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

function analyzeMarketAndProfit({ identified, searchPlan, activeResult, soldResult, body, fetchedAt }) {
  const active = dedupe((activeResult.listings || []).filter(x => Number.isFinite(x.totalPrice)));
  const sold = dedupe((soldResult.listings || []).filter(x => Number.isFinite(x.totalPrice)));
  const now = new Date(fetchedAt);
  const matchingConfidence = matchProfile(identified, [...sold, ...active]);
  const quality = marketConfidence(soldResult, activeResult, matchingConfidence, Date.now());

  const activePrices = withoutOutliers(active.map(x => x.totalPrice));
  const confirmedSold = sold.filter(x => !x.bestOffer && Date.parse(x.soldDate) <= now.getTime()
    && now.getTime() - Date.parse(x.soldDate) <= 90 * 86400000);
  const soldFirm = confirmedSold.map(x => x.totalPrice);
  const soldPrices = withoutOutliers(soldFirm);

  const sold7 = countWithin(sold, now, 7);
  const sold30 = countWithin(sold, now, 30);
  const sold90 = countWithin(sold, now, 90);
  const activeCount = activeResult.ok ? (Number.isInteger(activeResult.total) ? activeResult.total : active.length) : null;

  const soldStats = stats(soldPrices);
  const activeStats = stats(activePrices);
  const overrides = readOverrides(body);
  const priceDecision = chooseSalePrice({ soldStats, activeStats, sold30, sold90, overridePrice: overrides.targetSalePrice });

  const shipping = estimateShipping(identified, active, overrides.shippingCost);
  // Market quotes include shipping. Manual sale-price overrides are item-only.
  if (!(overrides.targetSalePrice > 0) && Number.isFinite(priceDecision.price)) {
    priceDecision.price = Math.max(0, priceDecision.price - shipping.buyerPaidShipping);
  }
  const fee = estimateEbayFees(identified.category, priceDecision.price, shipping.buyerPaidShipping, overrides);
  const cost = overrides.cost ?? nullableNumber(identified.observed_price);
  const economics = calculateEconomics({ salePrice: priceDecision.price, cost,
    buyerShipping: shipping.buyerPaidShipping, sellerShipping: shipping.sellerCost,
    packaging: overrides.packaging, feeRate: fee.rate, fixedFee: fee.fixed,
    promotedRate: overrides.promotedRate, purchaseTaxRate: overrides.purchaseTaxRate,
    minimumProfit: overrides.minimumProfit, minimumRoi: overrides.minimumRoi });
  const pricingReliable = soldPrices.length >= 3 && active.length > 0 && priceDecision.price > 0
    && confirmedSold.every(x => x.shippingKnown !== false);
  const calculable = soldResult.ok && activeResult.ok && soldPrices.length > 0 && active.length > 0
    && matchingConfidence.level !== 'Low';
  const promotedCost = economics?.promotedCost ?? null;
  const grossCollected = economics?.grossCollected ?? null;
  const netProfit = calculable ? economics?.netProfit ?? null : null;
  const roi = calculable ? economics?.roi ?? null : null;
  const sellThrough = activeCount > 0 ? (sold90 / activeCount) * 100 : null;
  const soldThroughInventoryRatio = activeCount != null ? (sold90 / Math.max(1, sold90 + activeCount)) * 100 : null;
  const pace30 = sold30 > 0 ? 30 / sold30 : null;
  const pace90 = sold90 > 0 ? 90 / sold90 : null;
  const averagePace = pace30 ?? pace90;
  const decisionIntelligence = buildDecision({ economics, quality, match: matchingConfidence.level,
    sold90, activeCount, providerOk: soldResult.ok && activeResult.ok, pricingReliable,
    shippingUnknown: shipping.unknown, shippingEstimated: shipping.estimated,
    bulky: shipping.difficulty === 'Bulky/verify dimensions', prices: soldFirm });
  const verdict = decisionIntelligence.verdict;

  const warnings = [];
  if (!activeResult.ok) warnings.push('Active Listingsは取得失敗です。0件として扱わず、データ不足として判定しています。');
  if (!soldResult.ok) warnings.push('Sold Listingsは取得失敗です。0 Soldとして扱わず、データ不足として判定しています。');
  if (sold.some(x => x.bestOffer)) warnings.push('Best Offerの表示価格は実際の成約価格と異なる可能性があります。');
  if (priceDecision.confidence === 'Low') warnings.push('Soldデータが不足しているため、想定販売価格の推定精度が低いです。');
  if (shipping.estimated) warnings.push(`推定送料と推定重量を使用しています。${shipping.label}`);

  return {
    version: '2.6.4',
    matchingConfidence,
    marketConfidence: quality,
    decisionIntelligence,
    matchEvidence: { accepted: [...sold, ...active].slice(0, 20).map(x => ({ itemId: x.itemId, method: x.matchMethod, ...x.matchEvidence })), rejected: [...(soldResult.rejectedEvidence || []), ...(activeResult.rejectedEvidence || [])] },
    product: {
      name: identified.product_name,
      brand: identified.brand,
      model: identified.model,
      upcGtinEan: normalizeDigits(identified.upc_gtin_ean),
      size: identified.size,
      color: identified.color,
      category: identified.category,
      specifications: identified.specifications || [],
      matchConfidence: matchingConfidence.level,
      notes: identified.identification_notes
    },
    search: searchPlan,
    active: {
      ok: activeResult.ok,
      source: activeResult.source,
      query: activeResult.query,
      count: activeCount,
      sampleCapped: Boolean(activeResult.sampleCapped),
      stats: activeStats,
      listings: active.slice(0, 25)
    },
    sold: {
      ok: soldResult.ok,
      source: soldResult.source,
      query: soldResult.query,
      total: soldResult.ok ? (Number.isInteger(soldResult.total) ? soldResult.total : sold.length) : null,
      sampleCapped: Boolean(soldResult.sampleCapped),
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
      landedCost: economics?.landedCost ?? null,
      purchaseTaxRate: overrides.purchaseTaxRate,
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
      estimatedEbayFees: economics?.fees ?? null,
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
  const rawShipping = nullableNumber(item.shippingPrice ?? item.shipping ?? item.shippingCost);
  const shipping = rawShipping ?? 0;
  return {
    title: item.title || '',
    price,
    shipping,
    shippingKnown: rawShipping != null || providerTotal != null,
    totalPrice: providerTotal ?? (price == null ? null : price + shipping),
    soldDate: sold ? normalizeDate(item.soldDate ?? item.dateSold ?? item.endedAt) : null,
    condition: item.condition || null,
    itemId: item.itemId || item.id || null,
    url: item.url || item.itemWebUrl || null,
    bestOffer: Boolean(item.bestOffer ?? item.best_offer ?? item.isBestOffer ?? /offer/i.test(item.buyingFormat || '')),
    seller: item.sellerUsername || item.seller?.username || item.seller || null,
    gtin: item.gtin || item.upc || item.ean || null,
    mpn: item.mpn || item.model || null,
    brand: item.brand || null,
    thumbnailUrl: item.thumbnailUrl || null
  };
}

function chooseSalePrice({ soldStats, activeStats, sold30, sold90, overridePrice }) {
  if (Number.isFinite(overridePrice) && overridePrice > 0) return { price: overridePrice, source: '手動上書き', confidence: 'Manual' };
  if (soldStats.median != null) {
    const trend = sold30 >= 3 && soldStats.average != null ? (soldStats.median * 0.7 + soldStats.average * 0.3) : soldStats.median;
    return { price: trend, source: 'Sold中央値優先', confidence: sold90 >= 3 ? 'High' : 'Medium' };
  }
  if (activeStats.median != null) return { price: activeStats.median, source: 'Active中央値補助', confidence: 'Low' };
  return { price: null, source: 'データ不足', confidence: 'Low' };
}

function estimateEbayFees(category, salePrice, buyerShipping, overrides) {
  const rate = overrides.feeRate ?? feeRateForCategory(category);
  const fixed = overrides.perOrderFee;
  return { rate, fixed, total: Number.isFinite(salePrice) ? (salePrice + buyerShipping) * (rate / 100) + fixed : null };
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
    return { sellerCost: manualShipping, buyerPaidShipping, estimated: false, unknown: false, label: '手動指定送料', weightLb: nullableNumber(p.packed_weight_lb), difficulty: 'Manual override' };
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
    unknown: !(nullableNumber(p.packed_weight_lb) > 0),
    label: `推定送料（推定重量 約${billable.toFixed(1)}lb / ${p.shipping_estimate_confidence || 'confidence不明'}）`,
    weightLb: billable,
    difficulty
  };
}

function readOverrides(body) {
  return {
    cost: nullableNumber(body.cost),
    packaging: nullableNumber(body.packaging) ?? 0.5,
    feeRate: nullableNumber(body.feeRate),
    perOrderFee: nullableNumber(body.perOrderFee ?? body.fixedFee) ?? 0.4,
    promotedRate: nullableNumber(body.promotedRate) ?? 0,
    purchaseTaxRate: nullableNumber(body.purchaseTaxRate) ?? 0,
    minimumProfit: nullableNumber(body.minimumProfit) ?? 25,
    minimumRoi: nullableNumber(body.minimumRoi) ?? 40,
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
  return limitedJson(request);
}

async function fetchJsonWithTimeout(url, init, timeoutMs, fallbackMessage) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(`${fallbackMessage} (${resp.status})`);
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${fallbackMessage}: timeout`);
    throw e;
  } finally {
    clearTimeout(id);
  }
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
  h.set('cache-control', 'no-store');
  h.set('x-content-type-options', 'nosniff');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(v, status = 200) {
  return cors(new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json;charset=utf-8' } }));
}
