const $ = (id) => document.getElementById(id);
const money = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '—';

async function fileToDataUrl(file){
  if(!file) return null;
  return await new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(file);
  });
}

$('productImage').addEventListener('change', () => {
  const f = $('productImage').files[0];
  if (!f) return;
  $('preview').src = URL.createObjectURL(f);
  $('previewWrap').classList.remove('hidden');
});

$('analyzeBtn').addEventListener('click', async () => {
  const product = $('productImage').files[0];
  if(!product){ alert('商品写真かバーコード写真を入れてください。'); return; }

  $('status').textContent = '商品を特定 → eBay Sold/Activeを自動検索中… 10〜30秒ほどかかることがあります。';
  $('analyzeBtn').disabled = true;
  try{
    const payload = {
      productImage: await fileToDataUrl(product),
      cost: $('cost').value,
      packaging: Number($('packaging').value || 0.5),
      feeRate: Number($('feeRate').value || 13.6),
      fixedFee: Number($('fixedFee').value || 0.40),
      shippingCost: $('shippingCost').value
    };
    const res = await fetch('/api/analyze', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '分析に失敗しました');
    render(data);
    $('status').textContent = '';
  } catch(e) {
    $('status').textContent = `エラー: ${e.message}`;
  } finally {
    $('analyzeBtn').disabled = false;
  }
});

function render(d){
  $('result').classList.remove('hidden');
  $('productName').textContent = d.product_name || '商品名不明';
  $('productMeta').textContent = [d.brand, d.model, d.upc ? `UPC ${d.upc}` : null, d.size, d.color].filter(Boolean).join(' · ');
  $('searchQuery').textContent = d.search_query ? `eBay検索: ${d.search_query}` : '';

  const statusMap = {OK:'✅ eBayデータ自動取得成功', PARTIAL:'⚠️ eBayデータを一部取得', FAILED:'❌ eBay自動取得失敗'};
  $('autoStatus').textContent = statusMap[d.auto_fetch_status] || d.auto_fetch_status || '';

  $('sold7').textContent = d.sold_7d ?? '—';
  $('sold30').textContent = d.sold_30d ?? '—';
  $('sold90').textContent = d.sold_90d ?? '—';
  $('activeCount').textContent = d.active_count ?? '—';
  $('str90').textContent = d.sell_through_90d == null ? '—' : `${d.sell_through_90d.toFixed(0)}%`;
  $('pace').textContent = d.days_per_sale ? `${d.days_per_sale.toFixed(1)}日/個` : '—';
  $('median').textContent = money(d.sold_median_price);
  $('activeMedian').textContent = money(d.active_median_price);
  $('shippingTop').textContent = money(d.shipping_cost);
  $('shippingLabel').textContent = d.shipping_estimate_label || '概算';
  $('feesTop').textContent = money(d.estimated_fees);
  $('profit').textContent = money(d.estimated_profit);
  $('roi').textContent = d.roi == null ? '—' : `${d.roi.toFixed(0)}%`;

  $('salePrice').textContent = money(d.target_sale_price);
  $('buyerShippingRevenue').textContent = `+${money(d.buyer_shipping_median || 0)}`;
  $('costOut').textContent = d.cost == null ? '値段不明' : `-${money(d.cost)}`;
  $('fees').textContent = `-${money(d.estimated_fees)}`;
  $('shipping').textContent = `-${money(d.shipping_cost)}`;
  $('packagingOut').textContent = `-${money(d.packaging)}`;
  $('profit2').textContent = d.estimated_profit == null ? '仕入れ価格を入力' : money(d.estimated_profit);

  $('soldPrices').innerHTML = (d.sold_prices || []).map(x => `<span>${money(x)}</span>`).join('') || '<span>取得なし</span>';
  $('soldDates').innerHTML = (d.sold_dates || []).map(x => `<span>${x}</span>`).join('') || '<span>取得なし</span>';
  $('warnings').innerHTML = (d.warnings || []).map(x => `<div>• ${escapeHtml(x)}</div>`).join('');

  const verdict = $('verdict');
  verdict.textContent = d.verdict || '—';
  verdict.className = 'verdict ' + String(d.verdict || '').toLowerCase();
  $('soldLink').href = d.sold_search_url || '#';
  $('activeLink').href = d.active_search_url || '#';
  $('result').scrollIntoView({behavior:'smooth',block:'start'});
}

function escapeHtml(s){
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
