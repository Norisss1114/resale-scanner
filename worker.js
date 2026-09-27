export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        if (!env.OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY が設定されていません' }, 500);
        if (!env.BROWSER) return json({ error: 'Cloudflare Browser Run の BROWSER binding が設定されていません' }, 500);

        const body = await request.json();
        if (!body.productImage) return json({ error: '商品写真またはバーコード写真を入れてください' }, 400);

        const asOf = new Date().toISOString().slice(0, 10);
        const identified = await identifyProduct(body.productImage, env, asOf);
        const query = buildBestQuery(identified);
        if (!query) return json({ error: '商品を特定できませんでした。バーコードか商品ラベルがはっきり写る写真でもう一度試してください。' }, 422);

        const [soldResult, activeResult] = await Promise.all([
          fetchEbay(env, query, true, identified),
          fetchEbay(env, query, false, identified),
        ]);

        const result = calculate({ identified, query, soldResult, activeResult, body, asOf });
        return json(result);
      } catch (e) {
        return json({ error: e?.message || String(e) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

async function identifyProduct(image, env, asOf) {
  const prompt = `You are a product identification engine for US retail-to-eBay resale research.
Today: ${asOf}.
Read the attached product photo OR barcode/UPC photo.
Return only structured JSON.

Identify as precisely as visible:
- brand
- exact product/model name
- model number / MPN if visible
- UPC/GTIN digits if visible (digits only)
- size, color, variation
- condition (assume new only if packaging/tag clearly indicates retail-new)
- clearance/store price if a price sticker is clearly visible
- a concise eBay search query that prioritizes UPC/MPN/model and avoids generic words
- estimated packed weight in pounds and packed dimensions in inches, only as a practical shipping estimate; mark confidence
- product category for resale fee/shipping context

Do not invent a UPC or model number. If uncertain use null.`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      brand: { type: ['string','null'] },
      product_name: { type: 'string' },
      model: { type: ['string','null'] },
      upc: { type: ['string','null'] },
      size: { type: ['string','null'] },
      color: { type: ['string','null'] },
      condition: { type: 'string' },
      observed_price: { type: ['number','null'] },
      search_query: { type: 'string' },
      category: { type: 'string' },
      packed_weight_lb: { type: ['number','null'] },
      packed_length_in: { type: ['number','null'] },
      packed_width_in: { type: ['number','null'] },
      packed_height_in: { type: ['number','null'] },
      shipping_estimate_confidence: { type: 'string' },
      confidence: { type: 'string' },
      notes: { type: 'string' }
    },
    required: ['brand','product_name','model','upc','size','color','condition','observed_price','search_query','category','packed_weight_lb','packed_length_in','packed_width_in','packed_height_in','shipping_estimate_confidence','confidence','notes']
  };

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5.6-luna',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: image, detail: 'high' }
      ] }],
      text: { format: { type: 'json_schema', name: 'product_id', strict: true, schema } }
    })
  });
  const raw = await r.json();
  if (!r.ok) throw new Error(raw?.error?.message || '商品画像のAI解析に失敗しました');
  return JSON.parse(extractOutputText(raw));
}

function buildBestQuery(p) {
  if (p.upc && /^\d{8,14}$/.test(String(p.upc))) return String(p.upc);
  if (p.search_query?.trim()) return p.search_query.trim();
  return [p.brand, p.model, p.product_name].filter(Boolean).join(' ').trim();
}

async function fetchEbay(env, query, sold, identified) {
  const params = new URLSearchParams({ _nkw: query, _ipg: '240' });
  if ((identified.condition || '').toLowerCase().includes('new')) params.set('LH_ItemCondition', '1000');
  if (sold) {
    params.set('LH_Sold', '1');
    params.set('LH_Complete', '1');
  }
  const url = `https://www.ebay.com/sch/i.html?${params.toString()}`;

  const schema = {
    type: 'object',
    properties: {
      result_count: { type: ['integer','null'] },
      blocked_or_captcha: { type: 'boolean' },
      page_note: { type: 'string' },
      listings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: ['number','null'] },
            shipping: { type: ['number','null'] },
            sold_date: { type: ['string','null'] },
            condition: { type: ['string','null'] },
            best_offer: { type: 'boolean' }
          },
          required: ['title','price','shipping','sold_date','condition','best_offer']
        }
      }
    },
    required: ['result_count','blocked_or_captcha','page_note','listings']
  };

  const prompt = sold
    ? `This is an eBay SOLD search results page. Extract the total result count and all visible sold listing cards that plausibly match this target product: ${identified.product_name}. Target identifiers: brand=${identified.brand || ''}, model=${identified.model || ''}, UPC=${identified.upc || ''}, size=${identified.size || ''}, color=${identified.color || ''}. Exclude obvious accessories, bundles, different models, different sizes/variations when materially different, and unrelated sponsored items. For each matching sold card extract title, displayed sold price, buyer-visible shipping charge (0 if free), sold date as YYYY-MM-DD when present, condition, and whether it says Best Offer. If eBay presents a bot challenge/captcha or listings are inaccessible, set blocked_or_captcha=true. Do not invent listings.`
    : `This is an eBay ACTIVE search results page. Extract the total result count and all visible active listing cards that plausibly match this target product: ${identified.product_name}. Target identifiers: brand=${identified.brand || ''}, model=${identified.model || ''}, UPC=${identified.upc || ''}, size=${identified.size || ''}, color=${identified.color || ''}. Exclude obvious accessories, bundles, materially different variants, and unrelated sponsored items. For each matching active card extract title, current price, buyer-visible shipping charge (0 if free), condition, and whether it accepts Best Offer. sold_date must be null. If eBay presents a bot challenge/captcha or listings are inaccessible, set blocked_or_captcha=true. Do not invent listings.`;

  try {
    const resp = await env.BROWSER.quickAction('json', {
      url,
      prompt,
      response_format: { type: 'json_schema', json_schema: schema },
      gotoOptions: { waitUntil: 'networkidle2', timeout: 25000 }
    });
    const payload = await resp.json();
    if (!resp.ok || payload?.success === false) {
      return { ok: false, url, result_count: null, blocked_or_captcha: true, page_note: payload?.errors?.[0]?.message || 'Browser Run failed', listings: [] };
    }
    const out = payload?.result || payload;
    return { ok: !out.blocked_or_captcha, url, ...out };
  } catch (e) {
    return { ok: false, url, result_count: null, blocked_or_captcha: true, page_note: e?.message || String(e), listings: [] };
  }
}

function calculate({ identified, query, soldResult, activeResult, body, asOf }) {
  const sold = dedupe((soldResult.listings || []).filter(x => x.price != null));
  const active = dedupe((activeResult.listings || []).filter(x => x.price != null));
  const now = new Date(asOf + 'T23:59:59Z');

  const sold7 = countWithin(sold, now, 7);
  const sold30 = countWithin(sold, now, 30);
  const sold90 = countWithin(sold, now, 90);
  const soldPricesFirm = sold.filter(x => !x.best_offer).map(x => Number(x.price)).filter(Number.isFinite);
  const soldPricesAll = sold.map(x => Number(x.price)).filter(Number.isFinite);
  const soldPrices = soldPricesFirm.length >= 2 ? soldPricesFirm : soldPricesAll;
  const activePrices = active.map(x => Number(x.price)).filter(Number.isFinite);

  const soldMedian = med(soldPrices);
  const activeMedian = med(activePrices);
  const targetSalePrice = soldMedian ?? activeMedian ?? 0;
  const buyerShippingMedian = med(sold.map(x => Number(x.shipping)).filter(Number.isFinite)) ?? 0;

  const activeCount = Number.isInteger(activeResult.result_count) ? activeResult.result_count : active.length || null;
  const soldCount = Number.isInteger(soldResult.result_count) ? soldResult.result_count : sold.length || null;
  const sellThrough90 = activeCount && activeCount > 0 ? (sold90 / activeCount) * 100 : null;
  const daysPerSale = sold30 > 0 ? 30 / sold30 : sold90 > 0 ? 90 / sold90 : null;

  const userCost = body.cost === '' || body.cost == null ? null : Number(body.cost);
  const cost = Number.isFinite(userCost) ? userCost : (Number.isFinite(Number(identified.observed_price)) ? Number(identified.observed_price) : null);
  const packaging = Number.isFinite(Number(body.packaging)) ? Number(body.packaging) : 0.5;
  const feeRate = Number.isFinite(Number(body.feeRate)) ? Number(body.feeRate) : 13.6;
  const fixedFee = Number.isFinite(Number(body.fixedFee)) ? Number(body.fixedFee) : 0.4;

  const autoShipping = estimateShipping(identified);
  const overrideShipping = body.shippingCost === '' || body.shippingCost == null ? null : Number(body.shippingCost);
  const shippingCost = Number.isFinite(overrideShipping) ? overrideShipping : autoShipping.amount;

  // Conservative default: assume free shipping to buyer unless sold comps consistently show paid shipping.
  const buyerShippingRevenue = buyerShippingMedian > 0 ? buyerShippingMedian : 0;
  const grossCollected = targetSalePrice + buyerShippingRevenue;
  const fees = grossCollected * feeRate / 100 + fixedFee;
  const profit = cost == null || !targetSalePrice ? null : grossCollected - cost - shippingCost - fees - packaging;
  const roi = profit != null && cost > 0 ? profit / cost * 100 : null;

  let verdict = '—';
  if (profit != null) {
    if (profit >= 15 && (sellThrough90 == null || sellThrough90 >= 25)) verdict = 'BUY';
    else if (profit >= 8) verdict = 'MAYBE';
    else verdict = 'SKIP';
  }

  const soldCoverage = soldCount && soldCount > 0 ? Math.min(100, sold.length / soldCount * 100) : null;
  const activeCoverage = activeCount && activeCount > 0 ? Math.min(100, active.length / activeCount * 100) : null;
  const autoStatus = soldResult.ok && activeResult.ok ? 'OK' : soldResult.ok || activeResult.ok ? 'PARTIAL' : 'FAILED';

  const warnings = [];
  if (!soldResult.ok) warnings.push('eBay Soldの自動取得に失敗しました。eBay側のbot対策等で発生することがあります。');
  if (!activeResult.ok) warnings.push('eBay Activeの自動取得に失敗しました。');
  if (soldCoverage != null && soldCoverage < 70) warnings.push(`Sold検索は総件数の約${Math.round(soldCoverage)}%を解析できています。販売数は最低値として見てください。`);
  if (sold.some(x => x.best_offer)) warnings.push('Best Offerの成約価格はeBay画面の表示価格と異なる場合があります。');
  warnings.push(`送料$${shippingCost.toFixed(2)}は${autoShipping.label}。実際の梱包サイズ・重量・配送先で変わります。`);
  warnings.push(`eBay手数料は${feeRate}% + $${fixedFee.toFixed(2)}で推定。カテゴリー、ストア、広告などで変わります。`);

  return {
    version: '2.0',
    product_name: identified.product_name,
    brand: identified.brand,
    model: identified.model,
    upc: identified.upc,
    size: identified.size,
    color: identified.color,
    category: identified.category,
    identification_confidence: identified.confidence,
    search_query: query,
    observed_price: identified.observed_price,
    cost,
    sold_7d: sold7,
    sold_30d: sold30,
    sold_90d: sold90,
    sold_result_count: soldCount,
    active_count: activeCount,
    sell_through_90d: sellThrough90,
    days_per_sale: daysPerSale,
    sold_median_price: soldMedian,
    active_median_price: activeMedian,
    target_sale_price: targetSalePrice,
    buyer_shipping_median: buyerShippingMedian,
    shipping_cost: shippingCost,
    shipping_estimate_label: autoShipping.label,
    estimated_fees: fees,
    fee_rate: feeRate,
    fixed_fee: fixedFee,
    packaging,
    estimated_profit: profit,
    roi,
    verdict,
    sold_prices: soldPricesAll,
    sold_dates: sold.map(x => x.sold_date).filter(Boolean).sort().reverse(),
    auto_fetch_status: autoStatus,
    sold_fetch_ok: soldResult.ok,
    active_fetch_ok: activeResult.ok,
    sold_search_url: soldResult.url,
    active_search_url: activeResult.url,
    sold_capture_rate: soldCoverage,
    active_capture_rate: activeCoverage,
    warnings,
    product_notes: identified.notes,
    browser_notes: [soldResult.page_note, activeResult.page_note].filter(Boolean).join(' | ')
  };
}

function estimateShipping(p) {
  const w = Number(p.packed_weight_lb);
  const l = Number(p.packed_length_in), wi = Number(p.packed_width_in), h = Number(p.packed_height_in);
  const dimensional = [l,wi,h].every(Number.isFinite) ? (l*wi*h)/139 : null;
  const billable = Math.max(Number.isFinite(w) ? w : 1.5, Number.isFinite(dimensional) ? dimensional : 0);
  let amount;
  if (billable <= 0.5) amount = 5.25;
  else if (billable <= 1) amount = 6.75;
  else if (billable <= 2) amount = 8.75;
  else if (billable <= 3) amount = 10.50;
  else if (billable <= 5) amount = 13.50;
  else if (billable <= 10) amount = 19.50;
  else amount = 29.00;
  return { amount, label: `概算送料（推定課金重量 約${billable.toFixed(1)}lb / ${p.shipping_estimate_confidence || 'confidence不明'}）` };
}

function extractOutputText(raw) {
  if (raw.output_text) return raw.output_text;
  for (const item of raw.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) return c.text;
  throw new Error('OpenAIからJSON出力を取得できませんでした');
}

function dedupe(items) {
  const seen = new Set(); const out = [];
  for (const x of items) {
    const key = [String(x.title || '').trim().toLowerCase(), x.sold_date || '', Number(x.price || 0).toFixed(2), Number(x.shipping || 0).toFixed(2)].join('|');
    if (seen.has(key)) continue;
    seen.add(key); out.push(x);
  }
  return out;
}
function countWithin(items, now, days) {
  const start = new Date(now.getTime() - (days - 1) * 86400000); start.setUTCHours(0,0,0,0);
  return items.filter(x => {
    if (!x.sold_date) return false;
    const d = new Date(x.sold_date + 'T00:00:00Z');
    return !isNaN(d) && d >= start && d <= now;
  }).length;
}
function med(a) {
  if (!a?.length) return null;
  const s = [...a].sort((x,y) => x-y); const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
function json(v, status=200) {
  return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json;charset=utf-8' } });
}
