const MARKETING_NOISE = new Set(['free', 'shipping', 'best', 'seller', 'bestseller', 'new', 'bundle', 'includes', 'included', 'premium', 'heavy', 'duty', 'limited', 'edition', 'sale', 'clearance']);
const GENERIC_WORDS = new Set(['and', 'the', 'with', 'for', 'from', 'model', 'color', 'size', 'item', 'product', 'kit']);
const VARIANTS = new Set(['max', 'lite', 'plus', 'pro', 'ultra', 'mini', 'standard', 'elite']);

export function normalizeProductTitle(value, brand = '') {
  const brandTokens = new Set(tokenize(brand));
  return tokenize(value)
    .filter((token, index, tokens) => !MARKETING_NOISE.has(token) && !(brandTokens.has(token) && index > 0 && tokens.slice(0, index).some(existing => brandTokens.has(existing))))
    .join(' ');
}

export function extractModelTokens(value) {
  return [...new Set(tokenize(value).filter(token => /[a-z]/.test(token) && /\d/.test(token) || /^\d{3,}[a-z]*$/.test(token)))];
}

export function extractKeyProductTokens(value, brand = '') {
  const brandTokens = new Set(tokenize(brand));
  return [...new Set(tokenize(normalizeProductTitle(value, brand)).filter(token => token.length > 2 && !GENERIC_WORDS.has(token) && !MARKETING_NOISE.has(token) && !brandTokens.has(token)))].slice(0, 8);
}

export function buildProductSearchPlan(product = {}) {
  const upc = digits(product.upc_gtin_ean || product.upc || product.gtin);
  const brand = clean(product.brand);
  const model = clean(product.model);
  const sku = clean(product.sku || product.mpn);
  const title = clean(product.product_name || product.title);
  const normalizedTitle = normalizeProductTitle(title, brand);
  const titleTokens = extractKeyProductTokens(title, brand).slice(0, 6).join(' ');
  const qualifiers = [clean(product.size), clean(product.color)].filter(Boolean);
  const queries = [];
  if (upc) queries.push({ type: 'upc_exact', value: upc, reason: 'Exact UPC / GTIN search.' });
  if (brand && model) queries.push({ type: 'brand_model', value: [brand, model, ...qualifiers].join(' '), reason: 'Brand and exact model number search.' });
  if (brand && sku && normalize(sku) !== normalize(model)) queries.push({ type: 'brand_sku', value: [brand, sku, ...qualifiers].join(' '), reason: 'Brand and retailer SKU / MPN search.' });
  if (brand && normalizedTitle) queries.push({ type: 'brand_title', value: [brand, normalizedTitle, ...qualifiers].join(' '), reason: 'Brand and normalized product title search.' });
  if (titleTokens) queries.push({ type: 'title_tokens', value: [brand, titleTokens, ...qualifiers].filter(Boolean).join(' '), reason: 'High-value title token search.' });
  const fallback = clean(product.search_keywords);
  if (fallback && !queries.some(query => normalize(query.value) === normalize(fallback))) queries.push({ type: 'fallback_keywords', value: fallback, reason: 'Fallback keywords supplied by product identification.' });
  return { primary: queries[0]?.value || '', strategy: queries[0]?.type || 'none', queries, normalizedTitle, keyTokens: extractKeyProductTokens(title, brand), modelTokens: extractModelTokens(model || title) };
}

export function evaluateListingMatch(listing = {}, product = {}) {
  const title = normalizeProductTitle(listing.title);
  if (!title) return no('Listing title is missing.');
  const targetId = digits(product.upc_gtin_ean || product.upc || product.gtin);
  const listingId = digits(listing.gtin || listing.upc);
  if (targetId && listingId) return listingId === targetId ? yes('upc_exact', 'Exact UPC / GTIN matched.') : no('UPC / GTIN differs.');
  if (targetId && title.replace(/\D/g, '').includes(targetId)) return yes('upc_exact', 'Exact UPC / GTIN appears in the listing title.');

  const brand = normalizeProductTitle(product.brand);
  if (brand && !includesLoose(title, brand)) return no('Brand does not match.');
  const model = normalizeProductTitle(product.model || product.mpn || product.sku);
  const listingModel = normalizeProductTitle(listing.mpn);
  if (model && !includesLoose(title, model) && !includesLoose(listingModel, model)) return no('Model number does not match.');

  const targetTitle = normalizeProductTitle(product.product_name || product.title, product.brand);
  if (variantMismatch(targetTitle, title)) return no('Product variant differs (for example Max, Plus, Pro, or Lite).');
  if (packMismatch(targetTitle, title)) return no('Pack quantity differs.');
  if (sizeMismatch(product.size, title)) return no('Product size differs.');

  if (model) return yes('brand_model', 'Brand and model number matched.');
  const keys = extractKeyProductTokens(targetTitle, product.brand);
  const titleSet = new Set(tokenize(title));
  const matched = keys.filter(token => titleSet.has(token));
  if (brand && keys.length && matched.length >= Math.max(2, Math.ceil(keys.length * 0.6))) return yes('brand_title', 'Brand and key product title tokens matched.');
  if (!brand && matched.length >= Math.max(2, Math.ceil(keys.length * 0.7))) return yes('title_tokens', 'High-value product title tokens matched.');
  return no('Too few identifying product tokens matched.');
}

export function matchProfile(product = {}) {
  if (digits(product.upc_gtin_ean || product.upc || product.gtin)) return { level: 'Exact identifier', score: 100, label: 'Exact identifier', matchMethod: 'upc_exact', matchReason: 'An exact UPC / GTIN is available for matching.' };
  if (clean(product.brand) && clean(product.model || product.mpn)) return { level: 'High', score: 85, label: 'High', matchMethod: 'brand_model', matchReason: 'Brand and model number are available for matching.' };
  if (clean(product.brand) && clean(product.product_name || product.title)) return { level: 'Medium', score: 65, label: 'Medium', matchMethod: 'brand_title', matchReason: 'Brand and normalized title are used; verify the exact variant.' };
  const keys = extractKeyProductTokens(product.product_name || product.title);
  return { level: keys.length >= 2 ? 'Low' : 'Low', score: 35, label: 'Low', matchMethod: keys.length >= 2 ? 'title_tokens' : 'fallback_keywords', matchReason: 'No reliable identifier or model is available; verify the product manually.' };
}

function variantMismatch(target, listing) {
  const targetVariants = new Set(tokenize(target).filter(token => VARIANTS.has(token)));
  const listingVariants = new Set(tokenize(listing).filter(token => VARIANTS.has(token)));
  return [...new Set([...targetVariants, ...listingVariants])].some(token => targetVariants.has(token) !== listingVariants.has(token));
}
function packMismatch(target, listing) { const a = packCount(target); const b = packCount(listing); return a != null && b != null && a !== b; }
function packCount(value) { return Number(tokenize(value).join(' ').match(/\b(\d+)\s*(?:pack|pk|count|ct)\b/)?.[1]) || null; }
function sizeMismatch(size, listing) { const expected = normalizeProductTitle(size); if (!expected) return false; const numeric = expected.match(/\b\d+(?:\.\d+)?\b/)?.[0]; const actual = listing.match(/\b(?:size\s*)?(\d+(?:\.\d+)?)\s*(?:in|inch|inches|ft|oz|lb|gb|tb)?\b/)?.[1]; return Boolean(numeric && actual && numeric !== actual); }
function tokenize(value) { return clean(value).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean); }
function includesLoose(haystack, needle) { if (!needle) return true; return haystack.includes(needle) || haystack.replace(/\s/g, '').includes(needle.replace(/\s/g, '')); }
function yes(matchMethod, matchReason) { return { matched: true, matchMethod, matchReason }; }
function no(matchReason) { return { matched: false, matchMethod: null, matchReason }; }
function digits(value) { const result = String(value || '').replace(/\D/g, ''); return result.length >= 8 && result.length <= 14 ? result : null; }
function normalize(value) { return normalizeProductTitle(value).replace(/\s/g, ''); }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
