export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        if (!env.OPENAI_API_KEY) return json({error:'OPENAI_API_KEY が設定されていません'},500);
        const body = await request.json();
        const asOf = new Date().toISOString().slice(0,10);
        const contents = [{type:'input_text', text: buildPrompt(body, asOf)}];
        if (body.productImage) contents.push({type:'input_image', image_url: body.productImage, detail:'high'});
        for (const img of (body.soldImages || []).slice(0,10)) {
          if (img) contents.push({type:'input_image', image_url: img, detail:'high'});
        }
        if (body.activeImage) contents.push({type:'input_image', image_url: body.activeImage, detail:'high'});

        const r = await fetch('https://api.openai.com/v1/responses', {
          method:'POST',
          headers:{'authorization':`Bearer ${env.OPENAI_API_KEY}`,'content-type':'application/json'},
          body:JSON.stringify({
            model: env.OPENAI_MODEL || 'gpt-5.6-luna',
            input:[{role:'user',content:contents}],
            text:{format:{type:'json_schema',name:'resale_scan',strict:true,schema:SCHEMA}}
          })
        });
        const raw = await r.json();
        if(!r.ok) return json({error:raw?.error?.message || 'OpenAI API error'},500);
        const ai = JSON.parse(extractOutputText(raw));
        return json(calculate(ai, body, asOf));
      } catch(e) { return json({error:e.message || String(e)},500); }
    }
    return env.ASSETS.fetch(request);
  }
};

function buildPrompt(b, asOf){return `あなたは米国eBay転売リサーチのデータ抽出器です。添付画像は、商品写真（任意）、eBay Sold Items検索結果のスクリーンショット1〜複数枚、最後にeBay現在出品検索結果（任意）です。

基準日: ${asOf}
目的: 画像に実際に見えているデータだけを正確に構造化してください。推測でSold件数・日付・価格を増やさないでください。

重要ルール:
- Soldスクショが複数ある場合、スクロールで同じ出品が重複して写ることがあります。title + date + price + shipping を中心に重複を除いて sold_listings に1回だけ入れてください。
- 各Soldカードから title、Sold日付、販売価格、buyer-facing shipping charge を抽出してください。
- "Free delivery/shipping" は buyer_shipping=0。
- "or Best Offer" が付く場合は best_offer=true。表示価格は実際の成立価格ではない可能性があるため注意。
- 検索結果件数（例: "4 results"）が明確なら sold_result_count / active_result_count に入れる。見えなければ null。
- sold_result_count はeBay画面に表示された検索結果総件数。sold_listingsは実際にスクショで確認できたユニークなカードだけ。
- 同一商品ではないカードは除外し excluded_count を増やしてください。
- 商品名は商品写真と検索結果から一致する最も具体的な名称。
- search_queryはeBayで同一商品を探す短い英語検索語。ブランド + 型番 + 商品名を優先。
- 日付はYYYY-MM-DD。年が省略されている場合、基準日${asOf}と画面文脈から合理的に補完。ただし不確実なら notes に明記。
- active_pricesには同一商品の現在出品価格だけを入れる。

ユーザー入力: 仕入れ $${b.cost}, 梱包材 $${b.packaging}, 手数料率 ${b.feeRate}%, 固定費 $${b.fixedFee}, 実発送コスト ${b.shippingCost ?? '未入力'}。
JSONだけを返してください。`;}

const SCHEMA={type:'object',additionalProperties:false,properties:{
  product_name:{type:'string'},search_query:{type:'string'},
  sold_result_count:{type:['integer','null']},active_result_count:{type:['integer','null']},
  sold_listings:{type:'array',items:{type:'object',additionalProperties:false,properties:{title:{type:'string'},date:{type:'string'},price:{type:'number'},buyer_shipping:{type:'number'},best_offer:{type:'boolean'}},required:['title','date','price','buyer_shipping','best_offer']}},
  active_prices:{type:'array',items:{type:'number'}},excluded_count:{type:'integer'},confidence:{type:'string'},notes:{type:'string'}
},required:['product_name','search_query','sold_result_count','active_result_count','sold_listings','active_prices','excluded_count','confidence','notes']};

function extractOutputText(raw){
  if(raw.output_text) return raw.output_text;
  for(const item of raw.output||[]) for(const c of item.content||[]) if(c.type==='output_text' && c.text) return c.text;
  throw new Error('JSON出力を取得できませんでした');
}

function calculate(ai,b,asOf){
  const sold = dedupe(ai.sold_listings||[]);
  const allPrices = sold.map(x=>Number(x.price)).filter(Number.isFinite);
  const firmPrices = sold.filter(x=>!x.best_offer).map(x=>Number(x.price)).filter(Number.isFinite);
  const pricesForComp = firmPrices.length ? firmPrices : allPrices;
  const soldMedian = med(pricesForComp);
  const activePrices = (ai.active_prices||[]).map(Number).filter(Number.isFinite);
  const target = soldMedian ?? med(activePrices) ?? 0;
  const buyerShippingVals = sold.map(x=>Number(x.buyer_shipping)).filter(Number.isFinite);
  const buyerShippingRevenue = med(buyerShippingVals) ?? 0;
  const feeBase = target + buyerShippingRevenue;
  const fees = feeBase*(Number(b.feeRate||0)/100) + Number(b.fixedFee||0);
  const shippingCost = b.shippingCost == null ? null : Number(b.shippingCost);
  const profit = shippingCost == null ? null : feeBase - Number(b.cost||0) - shippingCost - fees - Number(b.packaging||0);
  const roi = (profit != null && Number(b.cost)>0) ? profit/Number(b.cost)*100 : null;

  const now = new Date(asOf+'T23:59:59Z');
  const sold7 = countWithin(sold, now, 7);
  const sold30 = countWithin(sold, now, 30);
  const sold90 = countWithin(sold, now, 90);
  const activeCount = ai.active_result_count ?? (activePrices.length || null);
  const sellThrough90 = activeCount && activeCount>0 ? sold90/activeCount*100 : null;
  const daysPerSale = sold30>0 ? 30/sold30 : (sold90>0 ? 90/sold90 : null);

  const captured = sold.length;
  const total = ai.sold_result_count ?? captured;
  const captureRate = total>0 ? Math.min(100,captured/total*100) : null;
  const complete = ai.sold_result_count == null ? false : captured >= ai.sold_result_count;
  let quality = complete
    ? 'Sold検索結果を全件取得できているため、7/30/90日の販売数はこの検索条件内では高精度です。'
    : `Soldは${captured}件を画像から確認${ai.sold_result_count!=null?`（eBay表示は${ai.sold_result_count}件）`:''}。7/30/90日の件数は撮影できた範囲の最低値です。全結果をスクショすると精度が上がります。`;
  if(sold.some(x=>x.best_offer)) quality += ' Best Offer付きは表示価格と実際の成約価格が異なる場合があります。';
  if(shippingCost == null) quality += ' 実発送コストが未入力なので純利益はまだ確定計算していません。';

  let verdict='—';
  if(profit != null){
    verdict = (profit>=15 && (sellThrough90==null || sellThrough90>=30)) ? 'BUY' : (profit>=8 ? 'MAYBE':'SKIP');
  }

  return {
    product_name:ai.product_name, search_query:ai.search_query,
    sold_result_count:ai.sold_result_count, captured_sold_count:captured,
    active_count:activeCount, sold_7d:sold7, sold_30d:sold30, sold_90d:sold90,
    sell_through_90d:sellThrough90, days_per_sale:daysPerSale,
    sold_median_price:soldMedian, buyer_shipping_median:med(buyerShippingVals),
    target_sale_price:target, buyer_shipping_revenue:buyerShippingRevenue,
    estimated_fees:fees, shipping_cost:shippingCost, estimated_profit:profit, roi,
    cost:Number(b.cost||0), packaging:Number(b.packaging||0), sold_capture_rate:captureRate,
    sold_prices:allPrices, sold_dates:sold.map(x=>x.date).sort().reverse(),
    confidence:ai.confidence, notes:ai.notes, data_quality_message:quality, verdict
  };
}

function dedupe(items){
  const seen=new Set(); const out=[];
  for(const x of items){
    const key=[(x.title||'').trim().toLowerCase(),x.date,Number(x.price).toFixed(2),Number(x.buyer_shipping).toFixed(2)].join('|');
    if(seen.has(key)) continue; seen.add(key); out.push(x);
  }
  return out;
}
function countWithin(items,now,days){
  const start = new Date(now.getTime() - (days-1)*86400000); start.setUTCHours(0,0,0,0);
  return items.filter(x=>{const d=new Date(x.date+'T00:00:00Z'); return !isNaN(d) && d>=start && d<=now;}).length;
}
function med(a){if(!a?.length)return null;const s=[...a].sort((x,y)=>x-y);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function json(v,status=200){return new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json;charset=utf-8'}})}
