const $ = (id) => document.getElementById(id);
const money = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '—';

async function fileToDataUrl(file){
  if(!file) return null;
  return await new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(file);
  });
}
async function filesToDataUrls(files){
  return Promise.all([...files].slice(0,10).map(fileToDataUrl));
}

$('analyzeBtn').addEventListener('click', async () => {
  const product = $('productImage').files[0];
  const soldFiles = $('soldImages').files;
  const active = $('activeImage').files[0];
  if(!soldFiles.length){ alert('最低でも eBay Sold Items のスクショを1枚入れてください。'); return; }

  $('status').textContent = '画像を解析中…';
  $('analyzeBtn').disabled = true;
  try{
    const payload = {
      productImage: await fileToDataUrl(product),
      soldImages: await filesToDataUrls(soldFiles),
      activeImage: await fileToDataUrl(active),
      cost: Number($('cost').value || 0),
      packaging: Number($('packaging').value || 0),
      feeRate: Number($('feeRate').value || 0),
      fixedFee: Number($('fixedFee').value || 0),
      shippingCost: $('shippingCost').value === '' ? null : Number($('shippingCost').value)
    };
    const res = await fetch('/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '分析に失敗しました');
    render(data);
    $('status').textContent = '';
  }catch(e){ $('status').textContent = `エラー: ${e.message}`; }
  finally{ $('analyzeBtn').disabled = false; }
});

function render(d){
  $('result').classList.remove('hidden');
  $('productName').textContent = d.product_name || '商品名不明';
  $('searchQuery').textContent = d.search_query ? `検索語: ${d.search_query}` : '';
  $('sold7').textContent = d.sold_7d ?? '—';
  $('sold30').textContent = d.sold_30d ?? '—';
  $('sold90').textContent = d.sold_90d ?? '—';
  $('activeCount').textContent = d.active_count ?? '—';
  $('str90').textContent = d.sell_through_90d == null ? '—' : `${d.sell_through_90d.toFixed(0)}%`;
  $('pace').textContent = d.days_per_sale ? `${d.days_per_sale.toFixed(1)}日/個` : '—';
  $('median').textContent = money(d.sold_median_price);
  $('buyerShipping').textContent = money(d.buyer_shipping_median);
  $('profit').textContent = money(d.estimated_profit);
  $('roi').textContent = d.roi == null ? '—' : `${d.roi.toFixed(0)}%`;
  $('coverage').textContent = d.sold_capture_rate == null ? '—' : `${d.sold_capture_rate.toFixed(0)}%`;
  $('soldCount').textContent = d.sold_result_count ?? d.captured_sold_count ?? '—';
  $('salePrice').textContent = money(d.target_sale_price);
  $('buyerShippingRevenue').textContent = `+${money(d.buyer_shipping_revenue)}`;
  $('costOut').textContent = `-${money(d.cost)}`;
  $('fees').textContent = `-${money(d.estimated_fees)}`;
  $('shipping').textContent = d.shipping_cost == null ? '未入力' : `-${money(d.shipping_cost)}`;
  $('packagingOut').textContent = `-${money(d.packaging)}`;
  $('profit2').textContent = d.estimated_profit == null ? '送料入力で計算' : money(d.estimated_profit);
  $('soldPrices').innerHTML = (d.sold_prices||[]).map(x=>`<span>${money(x)}</span>`).join('') || '<span>取得なし</span>';
  $('soldDates').innerHTML = (d.sold_dates||[]).map(x=>`<span>${x}</span>`).join('') || '<span>取得なし</span>';
  $('confidence').textContent = `${d.data_quality_message || ''} 信頼度: ${d.confidence || '不明'}。${d.notes || ''}`;
  const verdict = $('verdict');
  verdict.textContent = d.verdict || '—'; verdict.className='verdict '+(d.verdict||'').toLowerCase();
  $('ebayLink').href = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(d.search_query || d.product_name || '')}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=1000`;
  $('result').scrollIntoView({behavior:'smooth',block:'start'});
}
