const ZIP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const ZIP_CACHE = new Map();
const STORE_CACHE = new Map();

export function validateZip(zipCode) {
  return /^\d{5}$/.test(String(zipCode || '').trim());
}

export function haversineMiles(from, to) {
  const lat1 = finite(from?.latitude);
  const lon1 = finite(from?.longitude);
  const lat2 = finite(to?.latitude);
  const lon2 = finite(to?.longitude);
  if ([lat1, lon1, lat2, lon2].some(value => value == null)) return null;
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function normalizeStore(value, origin = null) {
  const latitude = finite(value?.latitude);
  const longitude = finite(value?.longitude);
  const distance = origin ? haversineMiles(origin, { latitude, longitude }) : finite(value?.distanceMiles);
  return {
    id: text(value?.id) || null,
    retailer: text(value?.retailer) || null,
    name: text(value?.name) || null,
    address: text(value?.address) || null,
    city: text(value?.city) || null,
    state: text(value?.state)?.toUpperCase() || null,
    zipCode: normalizeZip(value?.zipCode),
    latitude,
    longitude,
    distanceMiles: distance == null ? null : Math.round(distance * 100) / 100,
    storeUrl: safeUrl(value?.storeUrl),
    source: text(value?.source) || null,
    providerStatus: text(value?.providerStatus) || 'ok'
  };
}

export function storesWithinRadius(stores, radiusMiles) {
  const radius = finite(radiusMiles);
  if (radius == null || radius < 0) return [];
  return (stores || []).filter(store => store.distanceMiles != null && store.distanceMiles <= radius);
}

export class LocationProvider {
  constructor(options = {}) {
    this.fetcher = options.fetcher || fetch;
    this.baseUrl = options.baseUrl || 'https://api.zippopotam.us/us';
  }

  async locate(zipCode) {
    const zip = String(zipCode || '').trim();
    if (!validateZip(zip)) return { status: 'invalid', location_status: 'unavailable', error: 'ZIP Code must be 5 digits' };
    const cached = getCache(ZIP_CACHE, zip);
    if (cached) return { ...cached, cache: 'hit' };
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/${zip}`, this.fetcher, { accept: 'application/json' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const place = body?.places?.[0];
      const location = {
        status: 'ok', location_status: 'ok', zipCode: zip,
        latitude: finite(place?.latitude), longitude: finite(place?.longitude),
        city: text(place?.['place name']) || null, state: text(place?.['state abbreviation']) || null,
        source: 'Zippopotam.us / GeoNames', fetchedAt: new Date().toISOString()
      };
      if (location.latitude == null || location.longitude == null) throw new Error('ZIP coordinates unavailable');
      setCache(ZIP_CACHE, zip, location, ZIP_CACHE_TTL_MS);
      return { ...location, cache: 'miss' };
    } catch (error) {
      return { status: 'unavailable', location_status: 'unavailable', zipCode: zip, error: error?.message || String(error), source: 'Zippopotam.us / GeoNames' };
    }
  }
}

class StoreProvider {
  constructor(options = {}) {
    this.fetcher = options.fetcher || fetch;
    this.locationProvider = options.locationProvider || new LocationProvider({ fetcher: this.fetcher });
  }

  async listStores(location) {
    const key = `${this.name}|${location.zipCode}`;
    const cached = getCache(STORE_CACHE, key);
    if (cached) return { ...cached, cache: 'hit' };
    try {
      const html = await this.loadHtml(location.zipCode);
      const rawStores = this.parse(html);
      if (!rawStores.length) throw new StoreUnavailableError(this.emptyMessage);
      const zipLookups = new Map();
      const stores = await Promise.all(rawStores.slice(0, 20).map(store => this.withCoordinates(store, location, zipLookups)));
      const value = storeResult(this.name, 'ok', stores.filter(store => store.latitude != null), this.source);
      if (!value.stores.length) throw new StoreUnavailableError('公開店舗情報から座標を解決できませんでした');
      setCache(STORE_CACHE, key, value, STORE_CACHE_TTL_MS);
      return { ...value, cache: 'miss' };
    } catch (error) {
      return storeResult(this.name, error instanceof StoreUnavailableError ? 'unavailable' : 'error', [], this.source, error?.message || String(error));
    }
  }

  async loadHtml(zipCode) {
    const response = await fetchWithTimeout(this.url(zipCode), this.fetcher, { accept: 'text/html,application/xhtml+xml' });
    if (!response.ok) throw new StoreUnavailableError(`公式Store Locator HTTP ${response.status}`);
    return response.text();
  }

  async withCoordinates(store, origin, zipLookups) {
    let coordinates = store;
    if (finite(store.latitude) == null || finite(store.longitude) == null) {
      const zip = normalizeZip(store.zipCode);
      if (!zipLookups.has(zip)) zipLookups.set(zip, this.locationProvider.locate(zip));
      const zipLocation = await zipLookups.get(zip);
      coordinates = zipLocation.status === 'ok'
        ? { ...store, latitude: zipLocation.latitude, longitude: zipLocation.longitude, source: `${store.source}; ZIP centroid` }
        : store;
    }
    return normalizeStore(coordinates, origin);
  }
}

export class WalmartStoreProvider extends StoreProvider {
  constructor(options = {}) {
    super(options); this.name = 'Walmart'; this.source = 'walmart_official_store_finder';
    this.emptyMessage = '公式Store Finderの公開HTMLに店舗結果がありません';
  }
  url(zip) { return `https://www.walmart.com/store-finder?location=${encodeURIComponent(zip)}`; }
  parse(html) { return parseWalmartStores(html); }
}

export class TargetStoreProvider extends StoreProvider {
  constructor(options = {}) {
    super(options); this.name = 'Target'; this.source = 'target_official_store_locator';
    this.emptyMessage = '公式Store Locatorの公開HTMLに店舗結果がありません';
  }
  url(zip) { return `https://www.target.com/store-locator/find-stores/${encodeURIComponent(zip)}`; }
  parse(html) { return parseTargetStores(html); }
}

export class HomeDepotStoreProvider extends StoreProvider {
  constructor(options = {}) {
    super(options); this.name = 'Home Depot'; this.source = 'homedepot_official_store_locator';
    this.emptyMessage = '公式Store Locatorの公開HTMLに店舗結果がありません';
  }
  url(zip) { return `https://www.homedepot.com/l/search/${encodeURIComponent(zip)}/full/`; }
  parse(html) { return parseHomeDepotStores(html); }
}

export function parseTargetStores(html) {
  const stores = [];
  const pattern = /href="\/sl\/([^"?]+)\/(\d+)"[^>]*>\s*<h3[^>]*>([^<]+).*?data-test="@store-locator\/StoreAddress"[^>]*>([^<]+)<\/a>/gis;
  for (const match of String(html).matchAll(pattern)) {
    const address = decodeHtml(match[4]);
    const parsed = parseUsAddress(address);
    stores.push({ id: match[2], retailer: 'Target', name: decodeHtml(match[3]), address: parsed.address, city: parsed.city, state: parsed.state, zipCode: parsed.zipCode, storeUrl: `https://www.target.com/sl/${match[1]}/${match[2]}`, source: 'target_official_store_locator', providerStatus: 'ok' });
  }
  return uniqueStores(stores);
}

export function parseWalmartStores(html) {
  const stores = [];
  const pattern = /<h3[^>]*>([^<]*(?:Supercenter|Neighborhood Market)[^<]*)<\/h3>[\s\S]{0,900}?Walmart[^#<]*#(\d+)[\s\S]{0,900}?([0-9][^<]{3,100}),\s*([^,<]+),\s*([A-Z]{2})\s+(\d{5})/gi;
  for (const match of String(html).matchAll(pattern)) stores.push({ id: match[2], retailer: 'Walmart', name: decodeHtml(match[1]), address: decodeHtml(match[3]), city: decodeHtml(match[4]), state: match[5], zipCode: match[6], storeUrl: `https://www.walmart.com/store/${match[2]}`, source: 'walmart_official_store_finder', providerStatus: 'ok' });
  return uniqueStores(stores);
}

export function parseHomeDepotStores(html) {
  const stores = [];
  const pattern = /(?:<h\d[^>]*>)?([^<]{2,60})\s+#(\d{3,5})(?:<\/h\d>)?[\s\S]{0,700}?([0-9][^<]{3,100})[\s\S]{0,120}?([^,<]+),\s*([A-Z]{2})\s+(\d{5})/gi;
  for (const match of String(html).matchAll(pattern)) stores.push({ id: match[2], retailer: 'Home Depot', name: decodeHtml(match[1]), address: decodeHtml(match[3]), city: decodeHtml(match[4]), state: match[5], zipCode: match[6], storeUrl: `https://www.homedepot.com/l/${match[2]}`, source: 'homedepot_official_store_locator', providerStatus: 'ok' });
  return uniqueStores(stores);
}

export function clearLocationCachesForTests() { ZIP_CACHE.clear(); STORE_CACHE.clear(); }

function parseUsAddress(value) {
  const match = String(value).match(/^(.+),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
  return match ? { address: match[1], city: match[2], state: match[3], zipCode: match[4] } : { address: value, city: null, state: null, zipCode: null };
}
function storeResult(retailer, status, stores, source, error = null) { return { retailer, status, stores, count: stores.length, source, error, fetchedAt: new Date().toISOString() }; }
function uniqueStores(stores) { const ids = new Set(); return stores.filter(store => store.id && !ids.has(store.id) && ids.add(store.id)); }
function normalizeZip(value) { return String(value || '').match(/\d{5}/)?.[0] || null; }
function finite(value) { const number = Number(value); return value !== '' && value != null && Number.isFinite(number) ? number : null; }
function text(value) { return String(value || '').trim(); }
function safeUrl(value) { try { return value ? new URL(value).toString() : null; } catch { return null; } }
function decodeHtml(value) { return String(value || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim(); }
function getCache(cache, key) { const item = cache.get(key); if (item && item.expiresAt > Date.now()) return item.value; cache.delete(key); return null; }
function setCache(cache, key, value, ttl) { cache.set(key, { value, expiresAt: Date.now() + ttl }); }
async function fetchWithTimeout(url, fetcher, headers) { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); try { return await fetcher(url, { headers: { ...headers, 'user-agent': 'ResaleScanner/2.5 (+https://github.com/Norisss1114/resale-scanner)' }, signal: controller.signal }); } finally { clearTimeout(timeout); } }
class StoreUnavailableError extends Error {}
