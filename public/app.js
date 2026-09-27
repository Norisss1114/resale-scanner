const $ = (id) => document.getElementById(id);
const money = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : 'データ不足';
const numberText = (n) => Number.isFinite(Number(n)) ? String(n) : '取得失敗/不足';
const pct = (n) => Number.isFinite(Number(n)) ? `${Number(n).toFixed(0)}%` : 'データ不足';

async function fileToDataUrl(file) {
  if (!file) return null;
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('productImage').addEventListener('change', () => previewFile($('productImage').files[0]));
$('barcodeImage').addEventListener('change', () => previewFile($('barcodeImage').files[0]));

function previewFile(file) {
  if (!file) return;
  $('preview').src = URL.createObjectURL(file);
  $('previewWrap').classList.remove('hidden');
}

$('analyzeBtn').addEventListener('click', async () => {
  const file = $('productImage').files[0] || $('barcodeImage').files[0];
  if (!file) {
    $('status').textContent = '商品写真またはバーコード写真を1枚入れてください。';
    return;
  }

  $('analyzeBtn').disabled = true;
  $('result').classList.add('hidden');
  setLoading('商品を特定中...');

  try {
    setTimeout(() => $('status').textContent = 'eBay Activeを検索中... Sold履歴も確認中...', 700);
    const payload = {
      productImage: await fileToDataUrl(file),
      cost: $('cost').value,
      packaging: $('packaging').value,
      feeRate: $('feeRate').value,
      perOrderFee: $('perOrderFee').value,
      promotedRate: $('promotedRate').value,
      shippingCost: $('shippingCost').value,
      targetSalePrice: $('targetSalePrice').value
    };

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '分析に失敗しました');
    $('status').textContent = '利益を計算中...';
    render(data);
    $('status').textContent = '';
  } catch (e) {
    $('status').textContent = `エラー: ${e.message}`;
  } finally {
    $('analyzeBtn').disabled = false;
  }
});

function setLoading(text) {
  $('status').textContent = text;
}

function render(d) {
  const product = d.product || {};
  const sold = d.sold || {};
  const active = d.active || {};
  const market = d.market || {};
  const profit = d.profit || {};
  const verdict = d.verdict || {};

  $('result').classList.remove('hidden');
  $('productName').textContent = product.name || '商品名不明';
  $('productMeta').textContent = [product.brand, product.model, product.upcGtinEan ? `UPC/GTIN ${product.upcGtinEan}` : null, product.size, product.color].filter(Boolean).join(' · ');
  $('matchConfidence').textContent = product.matchConfidence || 'Low';
  $('verdict').textContent = verdict.label || 'MAYBE';
  $('verdict').className = `verdict ${String(verdict.label || 'maybe').toLowerCase()}`;
  $('verdictReason').textContent = (verdict.reasons || []).join(' / ');

  setText('sold7', numberText(sold.count7d));
  setText('sold30', numberText(sold.count30d));
  setText('sold90', numberText(sold.count90d));
  setText('activeCount', numberText(active.count));
  setText('sellThrough', pct(market.sellThrough90d));
  setText('pace', sold.averageDaysPerSale ? `約${sold.averageDaysPerSale.toFixed(1)}日に1個` : 'データ不足');
  setText('soldMedian', money(sold.stats?.median));
  setText('activeMedian', money(active.stats?.median));
  setText('targetPrice', money(market.targetSalePrice));
  setText('netProfit', money(profit.netProfit));
  setText('roi', profit.roi == null ? 'データ不足' : `${profit.roi.toFixed(0)}%`);

  setText('brandOut', product.brand || '不明');
  setText('modelOut', product.model || '不明');
  setText('upcOut', product.upcGtinEan || '不明');
  setText('categoryOut', product.category || '不明');
  setText('specOut', (product.specifications || []).join(' / ') || '不明');
  setText('searchOut', `${d.search?.strategy || 'none'}: ${d.search?.primary || 'なし'}`);

  setText('soldAvg', money(sold.stats?.average));
  setText('soldMin', money(sold.stats?.min));
  setText('soldMax', money(sold.stats?.max));
  setText('pace30', sold.pace30Days ? `約${sold.pace30Days.toFixed(1)}日に1個` : 'データ不足');
  setText('pace90', sold.pace90Days ? `約${sold.pace90Days.toFixed(1)}日に1個` : 'データ不足');
  setText('formula', market.sellThroughFormula || '90日Sold ÷ Active × 100');
  setText('priceSource', `${market.targetSalePriceSource || '不明'} / 推定精度 ${market.priceConfidence || 'Low'}`);

  setText('grossCollected', money(profit.grossCollected));
  setText('buyerShipping', money(profit.buyerPaidShipping));
  setText('costOut', profit.cost == null ? '仕入れ価格不足' : money(profit.cost));
  setText('fees', money(profit.estimatedEbayFees));
  setText('feeRule', `${Number(profit.feeRate || 0).toFixed(2)}% + ${money(profit.perOrderFee)}`);
  setText('sellerShipping', money(profit.sellerShippingCost));
  setText('shippingLabel', profit.shippingLabel || '推定送料');
  setText('weightOut', profit.estimatedWeightLb ? `推定重量 ${profit.estimatedWeightLb.toFixed(1)}lb` : '推定重量なし');
  setText('packagingOut', money(profit.packaging));
  setText('promotedOut', `${Number(profit.promotedRate || 0).toFixed(1)}% / ${money(profit.promotedCost)}`);

  setText('sourceProduct', d.sources?.product || 'OpenAI Vision');
  setText('sourceActive', active.ok ? d.sources?.active : `${d.sources?.active || 'eBay Browse API'}: 取得失敗`);
  setText('sourceSold', sold.ok ? d.sources?.sold : `${d.sources?.sold || 'External Sold Provider'}: 取得失敗/未設定`);
  setText('updatedAt', d.sources?.updated ? new Date(d.sources.updated).toLocaleString() : '不明');

  renderWarnings(d.warnings || [], d.errors || []);
  renderListings('activeListings', active.listings || [], false);
  renderListings('soldListings', sold.listings || [], true);
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderWarnings(warnings, errors) {
  const items = [...warnings, ...errors.map(e => `API unavailable: ${e}`)];
  $('warnings').innerHTML = items.length ? items.map(x => `<div>${escapeHtml(x)}</div>`).join('') : '<div>警告なし</div>';
}

function renderListings(id, listings, sold) {
  const html = listings.length ? listings.map(x => `
    <li>
      <b>${escapeHtml(x.title || 'Untitled')}</b>
      <span>${money(x.totalPrice)} ${sold && x.soldDate ? `・${escapeHtml(x.soldDate)}` : ''}</span>
      <small>${[x.condition, x.itemId, x.seller, x.bestOffer ? 'Best Offer' : null].filter(Boolean).map(escapeHtml).join(' / ')}</small>
    </li>
  `).join('') : '<li><b>データ不足</b><span>取得失敗または該当データなし</span></li>';
  $(id).innerHTML = html;
}

function setText(id, value) {
  $(id).textContent = value;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
