const MARKETING_NOISE = new Set(['free', 'shipping', 'best', 'seller', 'bestseller', 'new', 'bundle', 'includes', 'included', 'premium', 'heavy', 'duty', 'limited', 'edition', 'sale', 'clearance']);
const GENERIC_WORDS = new Set(['and', 'the', 'with', 'for', 'from', 'model', 'color', 'size', 'item', 'product', 'kit']);
const VARIANTS = new Set(['max', 'lite', 'plus', 'pro', 'ultra', 'mini', 'standard', 'elite', 'select']);

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
  const targetId = digits(product.upc_gtin_ean || product.upc || product.gtin);
  const listingId = digits(listing.gtin || listing.upc);
  const brand = normalizeProductTitle(product.brand);
  const model = normalizeProductTitle(product.model || product.mpn);
  const listingModel = normalizeProductTitle(listing.mpn);
  const targetTitle = normalizeProductTitle(product.product_name || product.title, product.brand);
  const keys = extractKeyProductTokens(targetTitle, product.brand);
  const titleSet = new Set(tokenize(title));
  const matched = keys.filter(token => titleSet.has(token));
  const exact = Boolean(targetId && listingId && targetId.padStart(14, '0') === listingId.padStart(14, '0'));
  const conflicts = explicitVariantConflicts([product.product_name || product.title, product.size, product.color].filter(Boolean).join(' '), listing.title || '');
  if ((!exact || matched.length >= 2) && variantMismatch(targetTitle, title)) conflicts.push('variant');
  const evidence = {
    identifiersMatched: exact ? [targetId] : [],
    identifiersConflicted: targetId && listingId && !exact ? [listingId] : [],
    titleTokensMatched: matched,
    variantTokensMatched: tokenize(targetTitle).filter(token => VARIANTS.has(token) && titleSet.has(token)),
    variantConflicts: [...new Set(conflicts)],
    brandMatched: Boolean(brand && (includesLoose(title, brand) || normalizeProductTitle(listing.brand) === brand)),
    modelMatched: Boolean(model && (includesLoose(title, model) || listingModel === model))
  };
  const accept = (method, reason) => ({ ...yes(method, reason), matchEvidence: evidence });
  const reject = reason => ({ ...no(reason), matchEvidence: evidence });
  if (evidence.identifiersConflicted.length) return reject('UPC / GTIN differs.');
  if (conflicts.length) return reject(`Variant conflict: ${conflicts.join(', ')}`);
  if (exact) return accept('upc_exact', 'Listing identifier equals product identifier.');
  if (!title) return reject('Listing title is missing.');
  if (brand && !evidence.brandMatched) return reject('Brand does not match.');
  if (model && !evidence.modelMatched) return reject('Model number does not match.');
  if (evidence.brandMatched && evidence.modelMatched) return accept('brand_model', 'Brand + exact model');
  if (brand && keys.length && matched.length >= Math.max(2, Math.ceil(keys.length * 0.6))) return accept('brand_title', 'Brand + title tokens');
  if (!brand && matched.length >= Math.max(2, Math.ceil(keys.length * 0.7))) return accept('title_tokens', 'Title tokens only');
  return reject('Too few identifying product tokens matched.');
}

export function matchProfile(product = {}, listings = []) {
  const ranks = { upc_exact: 3, brand_model: 2, brand_title: 1, title_tokens: 0 };
  const verified = listings.map(item => item.matchMethod === 'upc_exact' && !item.matchEvidence?.identifiersMatched?.length ? { ...item, matchMethod: null, matchReason: 'Listing identifier evidence missing.' } : item);
  const weakest = verified.sort((a, b) => (ranks[a.matchMethod] ?? -1) - (ranks[b.matchMethod] ?? -1))[0];
  const rank = ranks[weakest?.matchMethod] ?? -1;
  const level = ['Low', 'Medium', 'High', 'Exact identifier'][Math.max(0, rank)];
  return { level, label: level, score: [35, 65, 85, 100][Math.max(0, rank)], matchMethod: weakest?.matchMethod || null, matchReason: weakest?.matchReason || 'No listing match evidence available.' };
}

export function explicitVariantConflicts(target, listing) {
  const a = String(target).toLowerCase(); const b = String(listing).toLowerCase();
  const conflicts = [];
  for (const [label, pattern] of [
    ['storage', /\b(\d+(?:\.\d+)?)\s*(gb|tb)\b/], ['capacity', /\b(\d+(?:\.\d+)?)\s*(ml|l|oz)\b/],
    ['screen size', /\b(\d+(?:\.\d+)?)\s*(?:inch|inches|in\b|\")/], ['voltage', /\b(\d+(?:\.\d+)?)\s*(?:v|volt)\b/],
    ['generation', /\b(\d+)(?:st|nd|rd|th)?\s*gen(?:eration)?\b/], ['pack', /\b(\d+)\s*[- ]?(?:pack|pk|count|ct)\b/]
  ]) {
    const x = a.match(pattern); const y = b.match(pattern);
    if (x && y && (x[1] !== y[1] || x[2] !== y[2])) conflicts.push(label);
  }
  for (const tokens of [['left', 'right'], ['mens', 'womens'], ['black', 'white', 'red', 'blue', 'pink', 'silver', 'gold']]) {
    const x = tokenize(a).filter(t => tokens.includes(t)); const y = tokenize(b).filter(t => tokens.includes(t));
    if (x.length === 1 && y.length === 1 && x[0] !== y[0]) conflicts.push(tokens.length > 2 ? 'color' : 'side/category');
  }
  const intendedCompatible = /\b(compatible|replacement|for)\b/.test(a);
  if (!intendedCompatible && /\b(compatible with|replacement for|for use with)\b/.test(b)) conflicts.push('compatible accessory');
  return conflicts;
}

function variantMismatch(target, listing) {
  const targetVariants = new Set(tokenize(target).filter(token => VARIANTS.has(token)));
  const listingVariants = new Set(tokenize(listing).filter(token => VARIANTS.has(token)));
  return [...new Set([...targetVariants, ...listingVariants])].some(token => targetVariants.has(token) !== listingVariants.has(token));
}
function tokenize(value) { return clean(value).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean); }
function includesLoose(haystack, needle) { if (!needle) return true; return ` ${haystack} `.includes(` ${needle} `); }
function yes(matchMethod, matchReason) { return { matched: true, matchMethod, matchReason }; }
function no(matchReason) { return { matched: false, matchMethod: null, matchReason }; }
function digits(value) { const result = String(value || '').replace(/\D/g, ''); return result.length >= 8 && result.length <= 14 ? result : null; }
function normalize(value) { return normalizeProductTitle(value).replace(/\s/g, ''); }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
