// Public HTML only, no cookies, browser impersonation, internal APIs or challenge retries.
import { writeFile } from 'node:fs/promises';
import { parseDocument, DomUtils } from 'htmlparser2';
import { parseTargetDeals, parseWalmartDeals, parseHomeDepotDeals, parseKohlsDeals } from '../lib/retailer-providers.mjs';

const pages = [
  ['Target', 'https://www.target.com/c/clearance/-/N-5q0ga', parseTargetDeals],
  ['Walmart', 'https://www.walmart.com/shop/deals/clearance', parseWalmartDeals],
  ['Home Depot', 'https://www.homedepot.com/daily-deals', parseHomeDepotDeals],
  ["Kohl's", 'https://www.kohls.com/catalog/clearance.jsp?CN=Promotions%3AClearance', parseKohlsDeals],
  ['Best Buy', 'https://www.bestbuy.com/site/electronics/outlet-refurbished-clearance/pcmcat142300050026.c?id=pcmcat142300050026'],
  ["Lowe's", 'https://www.lowes.com/l/savings'],
  ['Menards', 'https://www.menards.com/main/c-1642874320226744.htm'],
  ["Macy's", 'https://www.macys.com/shop/sale/clearance-closeout?id=54698'],
  ['Walgreens', 'https://www.walgreens.com/offers/offers.jsp/weeklyad'],
  ['CVS', 'https://www.cvs.com/shop/deals'],
  ['Costco', 'https://www.costco.com/warehouse-savings.html'],
  ["Sam's Club", 'https://www.samsclub.com/shop/savings']
];
const results = [];
for (const [retailer, url, parser] of pages) {
  if (process.argv[3] && process.argv[3] !== retailer) continue;
  let result = { retailer, url, checkedAt: new Date().toISOString(), environment: 'local Node server-side fetch; NOT Cloudflare edge', httpStatus: null, parsedCount: null, sample: null };
  try {
    const response = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'ResaleScanner/2.6.4 (+https://github.com/Norisss1114/resale-scanner)' }, signal: AbortSignal.timeout(15000) });
    result.httpStatus = response.status;
    if (response.ok) {
      const html = await response.text();
      const doc = parseDocument(html);
      result.bytes = html.length;
      result.jsonLdScripts = DomUtils.findAll(n => n.name === 'script' && n.attribs?.type === 'application/ld+json', doc.children).length;
      if (parser) {
        const deals = parser(html);
        result.parsedCount = deals.length;
        if (deals.length) {
          const d = deals[0];
          result.sample = { title: d.title, currentPrice: d.salePrice, referencePrice: d.regularPrice, referencePriceType: d.referencePriceType, discount: d.discountPercent, url: d.productUrl, parser: d.parserSource };
          result.fields = Object.fromEntries(['title', 'salePrice', 'regularPrice', 'productUrl', 'imageUrl', 'model', 'sku', 'brand', 'category', 'rating', 'reviewCount', 'purchasePopularity', 'availability'].map(k => [k, deals.filter(d => d[k] != null && d[k] !== 'unknown').length]));
        }
      } else result.note = 'Research only; product field extraction and Cloudflare stability not validated';
    } else result.note = 'Unavailable; no bypass or challenge retry';
  } catch (error) { result.error = error.name === 'TimeoutError' ? 'timeout' : 'fetch_or_parse_error'; }
  results.push(result);
  console.log(JSON.stringify(result));
}
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(results, null, 2));
