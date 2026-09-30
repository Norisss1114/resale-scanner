import { parseDocument, DomUtils } from 'htmlparser2';

const origins = { Target: 'https://www.target.com', Walmart: 'https://www.walmart.com', "Kohl's": 'https://www.kohls.com' };
const sources = { Target: 'target_public_clearance', Walmart: 'walmart_public_clearance', "Kohl's": 'kohls_clearance' };
const nodeText = node => node?.type === 'text' ? node.data : (node?.children || []).map(nodeText).join(' ');
const text = node => nodeText(node).replace(/\s+/g, ' ').trim();
const find = (root, predicate) => DomUtils.findAll(predicate, root.children || []);
const attr = (node, key) => node.attribs?.[key] || '';
const marker = node => `${attr(node, 'data-test')} ${attr(node, 'data-testid')} ${attr(node, 'class')} ${attr(node, 'itemprop')}`;

export function exactPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const v = String(value ?? '').trim().replace(/^(?:Now|Sale|Clearance|Was|Reg(?:ular)?\.?)\s*/i, '');
  return /^\$?\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(v) ? Number(v.replace(/[$,]/g, '')) : null;
}

export function productUrl(retailer, value) {
  if (!value) return null;
  try {
    const url = new URL(value, origins[retailer]);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== new URL(origins[retailer]).hostname) return null;
    const paths = { Target: /^\/p\//, Walmart: /^\/ip\//, "Kohl's": /^\/product\/prd-/ };
    if (!paths[retailer].test(url.pathname)) return null;
    // Preserve variant-selecting query parameters; remove only tracking parameters.
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|ath|ref$|clkid$|cid$)/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

export function normalizePublicProduct(item, retailer, parserSource) {
  const offers = Array.isArray(item.offers) ? item.offers : item.offers ? [item.offers] : [];
  // A price range or several variants cannot establish one purchase price.
  if (offers.length > 1 || offers[0]?.['@type'] === 'AggregateOffer') return null;
  const offer = offers[0] || {};
  if (offer.priceCurrency && offer.priceCurrency !== 'USD') return null;
  if (item.memberOnly || item.priceRequiresCoupon) return null;
  const title = typeof item.name === 'string' ? item.name.trim() : '';
  const salePrice = exactPrice(item.currentPrice ?? offer.price);
  const regularPrice = exactPrice(item.regularPrice);
  const clearance = item.clearance === true || /^(clearance|rollback)$/i.test(item.dealType || '');
  const url = productUrl(retailer, item.url || offer.url);
  if (!title || salePrice == null || !url || (!(regularPrice > salePrice) && !clearance)) return null;
  if (regularPrice != null && regularPrice < salePrice) return null;
  const sku = item.sku != null ? String(item.sku) : null;
  const image = Array.isArray(item.image) ? item.image[0] : item.image;
  const brand = typeof item.brand === 'string' ? item.brand : item.brand?.name || null;
  const availabilityText = String(item.availability || offer.availability || '').toLowerCase();
  const availability = /out.?of.?stock|unavailable|sold.?out/.test(availabilityText) ? 'out_of_stock'
    : /in.?stock|^available$/.test(availabilityText) ? 'in_stock' : 'unknown';
  const model = item.model || item.mpn || null;
  const referencePriceType = regularPrice == null ? null : item.referencePriceType || 'regular';
  return { id: `${retailer.toLowerCase().replace(/[^a-z]/g, '')}_${sku || url}`, retailer, title, brand, model,
    sku, productId: item.productId || sku, upc: item.gtin12 || null, gtin: item.gtin13 || item.gtin14 || null,
    currentPrice: salePrice, salePrice, regularPrice, referencePrice: regularPrice, referencePriceType,
    discountPercent: regularPrice > salePrice && regularPrice > 0 ? (regularPrice - salePrice) / regularPrice * 100 : null,
    couponPrice: exactPrice(item.couponPrice), couponRequired: item.couponRequired === true,
    memberPrice: exactPrice(item.memberPrice), memberRequired: item.memberRequired === true,
    productUrl: url, imageUrl: typeof image === 'string' && /^https:\/\//.test(image) ? image : image?.url || null,
    category: typeof item.category === 'string' ? item.category : null,
    rating: exactPrice(item.aggregateRating?.ratingValue), reviewCount: exactPrice(item.aggregateRating?.reviewCount),
    purchasePopularity: item.purchasePopularity || null, availability, fulfillment: item.fulfillment || null,
    dealType: clearance ? 'clearance' : 'sale', source: sources[retailer], sourceType: clearance ? 'clearance' : 'sale',
    parserSource, sourceConfidence: parserSource === 'html_card' ? 'Medium' : 'High',
    dataQuality: regularPrice != null && sku && brand ? 'High' : sku || brand ? 'Medium' : 'Low',
    providerStatus: 'ok', fetchedAt: new Date().toISOString() };
}

function jsonScripts(html, jsonLd = false) {
  const doc = typeof html === 'string' ? parseDocument(html) : html;
  return find(doc, n => n.name === 'script' && (jsonLd ? attr(n, 'type') === 'application/ld+json'
    : attr(n, 'type') === 'application/json' || ['__NEXT_DATA__', '__PRELOADED_STATE__', '__INITIAL_STATE__'].includes(attr(n, 'id'))))
    .flatMap(n => { try { return [JSON.parse(text(n))]; } catch { return []; } });
}

function objects(values, predicate) {
  const output = [], stack = [...values];
  let visited = 0;
  while (stack.length && visited++ < 60000) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (predicate(value)) output.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
  return output;
}

function jsonLd(html, retailer) {
  return objects(jsonScripts(html, true), x => x['@type'] === 'Product')
    .map(x => normalizePublicProduct(x, retailer, 'json_ld')).filter(Boolean);
}

export function parseTargetEmbeddedState(html) {
  return objects(jsonScripts(html), x => x.tcin && x.item && x.price).map(x => normalizePublicProduct({
    name: x.item.product_description?.title, url: x.item.enrichment?.buy_url,
    currentPrice: x.price.current_retail, regularPrice: x.price.reg_retail,
    clearance: x.price.is_clearance === true, sku: x.tcin,
    brand: x.item.primary_brand?.name, model: x.item.product_description?.model_number,
    image: x.item.enrichment?.images?.primary_image_url, category: x.category?.name,
    aggregateRating: { ratingValue: x.ratings_and_reviews?.statistics?.rating?.average,
      reviewCount: x.ratings_and_reviews?.statistics?.rating?.count }
  }, 'Target', 'embedded_state')).filter(Boolean);
}

export function parseWalmartNextData(html) { return walmartState(html, true); }
export function parseWalmartEmbeddedState(html) { return walmartState(html, false); }
function walmartState(html, nextOnly) {
  const values = jsonScripts(html);
  const products = nextOnly ? values.flatMap(x => x.props?.pageProps?.initialData?.searchResult?.itemStacks || [])
    .flatMap(x => x.items || []).filter(x => x.__typename === 'Product')
    : objects(values, x => x.__typename === 'Product' && x.priceInfo && (x.usItemId || x.id));
  return products.map(x => normalizePublicProduct({ name: x.name, sku: x.usItemId || x.id,
    currentPrice: x.priceInfo.linePrice, regularPrice: x.priceInfo.wasPrice,
    referencePriceType: 'was', brand: x.brand || x.manufacturerName, model: x.model,
    url: x.canonicalUrl, image: x.imageInfo?.thumbnailUrl, category: x.catalogProductType,
    clearance: x.badges?.flags?.some(b => /^(CLEARANCE|ROLLBACK)$/.test(b.key)),
    availability: x.availabilityStatusDisplayValue || x.availabilityStatusV2?.display,
    fulfillment: (x.fulfillmentSummary || []).map(f => f.fulfillment).filter(Boolean).join(', ') || null,
    aggregateRating: { ratingValue: x.rating?.averageRating, reviewCount: x.rating?.numberOfReviews },
    purchasePopularity: x.socialProof?.text, memberPrice: x.priceInfo.memberPriceString
  }, 'Walmart', nextOnly ? 'next_data' : 'embedded_state')).filter(Boolean);
}

export function parseKohlsEmbeddedState(html) {
  return objects(jsonScripts(html), x => x.productId && x.productTitle && x.productURL)
    .map(x => normalizePublicProduct({ name: x.productTitle, sku: x.productId, url: x.productURL,
      currentPrice: x.salePrice, regularPrice: x.regularPrice, clearance: x.isClearance === true,
      brand: x.brand, image: x.imageURL, category: x.category, couponPrice: x.couponPrice,
      couponRequired: x.couponRequired, memberPrice: x.memberPrice, memberRequired: x.memberRequired,
      memberOnly: x.memberOnly, priceRequiresCoupon: x.priceRequiresCoupon
    }, "Kohl's", 'embedded_state')).filter(Boolean);
}

function htmlCards(html, retailer) {
  const doc = typeof html === 'string' ? parseDocument(html) : html;
  const cards = find(doc, n => /(?:^|[\s/])(?:product-card|productCard|ProductCard|product-tile|productTile|product)(?:$|[\s/])/.test(marker(n))
    || (retailer === 'Walmart' && attr(n, 'data-item-id')));
  return cards.flatMap(card => {
    const links = find(card, n => n.name === 'a' && productUrl(retailer, attr(n, 'href')));
    const urls = new Set(links.map(n => productUrl(retailer, attr(n, 'href'))));
    if (urls.size !== 1) return [];
    const titleNode = find(card, n => /product-title|productTitle|product-name|productName/.test(marker(n)))[0] || links.find(n => text(n));
    const priceNode = find(card, n => /(?:^|[\s/])(?:current-price|currentPrice|sale-price|salePrice|product-price|productPrice|price)(?:$|[\s/])/.test(marker(n)))[0];
    const refNode = find(card, n => ['del', 's'].includes(n.name) || /regular-price|was-price|reference-price|regPrice/.test(marker(n)))[0];
    const image = find(card, n => n.name === 'img')[0];
    const cardText = text(card);
    const conditional = /with (?:code|coupon)|member(?:s)?(?:-only| only)|after (?:coupon|rebate)/i.test(cardText);
    // Do not conflate an unlabeled conditional price with an unconditional purchase price.
    if (conditional) return [];
    return [normalizePublicProduct({ name: text(titleNode), url: [...urls][0],
      currentPrice: attr(priceNode || {}, 'content') || text(priceNode), regularPrice: text(refNode),
      referencePriceType: refNode ? (/was/i.test(text(refNode)) ? 'was' : 'reference') : null,
      clearance: /\bclearance\b/i.test(cardText), image: attr(image || {}, 'src'),
      sku: attr(card, 'data-tcin') || attr(card, 'data-item-id') || attr(card, 'data-product-id'),
      brand: text(find(card, n => /(?:^|\s)brand(?:$|\s)/.test(marker(n)))[0])
    }, retailer, 'html_card')].filter(Boolean);
  });
}

export const parseTargetHtmlCards = html => htmlCards(html, 'Target');
export const parseWalmartHtmlCards = html => htmlCards(html, 'Walmart');
export const parseKohlsHtmlCards = html => htmlCards(html, "Kohl's");
export const parseTargetJsonLd = html => jsonLd(html, 'Target');
export const parseWalmartJsonLd = html => jsonLd(html, 'Walmart');
export const parseKohlsJsonLd = html => jsonLd(html, "Kohl's");

export function runParserCandidates(html, parsers) {
  const deals = [], diagnostics = [];
  const doc = parseDocument(String(html));
  for (const parser of parsers) {
    try { const found = parser(doc); deals.push(...found); diagnostics.push({ parser: parser.name, count: found.length, status: 'ok' }); }
    catch { diagnostics.push({ parser: parser.name, count: 0, status: 'parse_error' }); }
  }
  return { deals, diagnostics };
}

export function explicitEmptyWalmart(html) {
  return jsonScripts(html).some(x => Array.isArray(x.props?.pageProps?.initialData?.searchResult?.itemStacks)
    && x.props.pageProps.initialData.searchResult.itemStacks.length === 0);
}
