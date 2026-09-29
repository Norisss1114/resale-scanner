const $ = id => document.getElementById(id);
const money = n => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : 'データ不足';
const numberText = n => Number.isFinite(Number(n)) ? String(n) : '取得失敗/不足';
const pct = n => Number.isFinite(Number(n)) ? `${Number(n).toFixed(0)}%` : 'データ不足';
const WATCHLIST_KEY = 'resaleScanner.watchlist.v1';
let latestDeals = [];

document.querySelectorAll('.navButton').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));

function showView(id) {
  document.querySelectorAll('.appView').forEach(view => view.classList.toggle('hidden', view.id !== id));
  document.querySelectorAll('.navButton').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  if (id === 'watchlistView') renderWatchlist();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

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
  if (!file) return setText('status', '商品写真またはバーコード写真を1枚入れてください。');
  $('analyzeBtn').disabled = true;
  $('result').classList.add('hidden');
  setText('status', '商品を特定中...');
  try {
    const payload = {
      productImage: await fileToDataUrl(file), cost: $('cost').value, packaging: $('packaging').value,
      feeRate: $('feeRate').value, perOrderFee: $('perOrderFee').value, promotedRate: $('promotedRate').value,
      shippingCost: $('shippingCost').value, targetSalePrice: $('targetSalePrice').value
    };
    setText('status', 'eBay Sold / Activeを検索中...');
    const data = await postJson('/api/analyze', payload);
    renderProductAnalysis(data);
    setText('status', '');
  } catch (e) {
    setText('status', `エラー: ${e.message}`);
  } finally {
    $('analyzeBtn').disabled = false;
  }
});

$('scanDealsBtn').addEventListener('click', scanDeals);

async function scanDeals() {
  $('scanDealsBtn').disabled = true;
  $('dealResults').innerHTML = '';
  $('dealSummary').classList.add('hidden');
  setText('dealStatus', 'Mock Dealsを取得し、eBay市場を順番に分析しています...');
  try {
    const payload = {
      provider: 'mock',
      filters: { minimumProfit: $('minimumProfit').value, minimumRoi: $('minimumRoi').value, minimumDiscount: $('minimumDiscount').value },
      sortBy: $('dealSort').value
    };
    const data = await postJson('/api/deals/scan', payload);
    latestDeals = data.deals || [];
    renderDealScan(data);
    setText('dealStatus', '');
  } catch (e) {
    setText('dealStatus', `Provider API failure: ${e.message}`);
    $('dealResults').innerHTML = stateMessage('Deal Providerからデータを取得できませんでした。', 'failure');
  } finally {
    $('scanDealsBtn').disabled = false;
  }
}

function renderDealScan(data) {
  const counts = data.counts || {};
  $('dealSummary').classList.remove('hidden');
  $('dealSummary').textContent = `Mock Provider: ${counts.fetched ?? 0}件取得 · ${counts.analyzed ?? 0}件分析 · 条件一致 ${counts.matchedFilters ?? 0}件 · エラー ${counts.errors ?? 0}件`;
  if (!counts.fetched) return $('dealResults').innerHTML = stateMessage('Deals 0件: Providerは正常に応答しましたが、Dealはありません。', 'zero');
  if (!latestDeals.length) return $('dealResults').innerHTML = stateMessage('指定した利益・ROI・割引条件に一致するDealは0件です。', 'zero');
  $('dealResults').innerHTML = latestDeals.map(item => dealCard(item, false)).join('');
}

function dealCard(item, watchlist) {
  const deal = item.deal || {};
  if (item.status === 'ERROR') return `<article class="dealCard errorCard"><div class="sourceTag">${escapeHtml(deal.source || 'mock')}</div><h3>${escapeHtml(deal.title || 'Deal')}</h3><p class="errorText">Analysis failure: ${escapeHtml(item.error || '不明なエラー')}</p></article>`;
  const a = item.analysis || {};
  const sold = a.sold || {};
  const active = a.active || {};
  const market = a.market || {};
  const profit = a.profit || {};
  const soldState = sold.ok ? (sold.count90d === 0 ? 'Sold 0件' : `${sold.count90d}件`) : 'Sold取得失敗';
  const activeState = active.ok ? (active.count === 0 ? 'Active 0件' : `${active.count}件`) : 'Active取得失敗';
  const button = watchlist
    ? `<button class="secondary removeWatch" data-id="${escapeHtml(deal.id)}">Remove</button>`
    : `<button class="secondary addWatch" data-id="${escapeHtml(deal.id)}">Add to Watchlist</button>`;
  return `<article class="dealCard">
    <div class="dealMedia">${deal.imageUrl ? `<img src="${escapeHtml(deal.imageUrl)}" alt="${escapeHtml(deal.title)}" loading="lazy" />` : '<div class="imageFallback">NO IMAGE</div>'}<div class="mockFlag">MOCK</div></div>
    <div class="dealBody">
      <div class="scoreRow"><div><span>DEAL SCORE</span><strong>${item.dealScore?.score ?? 0}</strong><small>${escapeHtml(item.dealScore?.label || 'Weak')}</small></div><div class="verdict ${String(item.verdict?.label || 'maybe').toLowerCase()}">${escapeHtml(item.verdict?.label || 'MAYBE')}</div></div>
      <div class="retailer">${escapeHtml(deal.retailer || 'Unknown retailer')}</div><h3>${escapeHtml(deal.title || 'Untitled deal')}</h3>
      <div class="priceLine"><span>Regular <s>${money(deal.regularPrice)}</s></span><strong>${money(deal.salePrice)}</strong><b>${pct(deal.discountPercent)} OFF</b></div>
      <div class="dealMetrics">
        <div><span>Sold Median</span><b>${money(sold.stats?.median)}</b></div><div><span>Sold 7 / 30 / 90</span><b>${numberText(sold.count7d)} / ${numberText(sold.count30d)} / ${soldState}</b></div>
        <div><span>Active</span><b>${activeState}</b></div><div><span>Sell-through</span><b>${pct(market.sellThrough90d)}</b></div>
        <div><span>Estimated Fees</span><b>${money(profit.estimatedEbayFees)}</b></div><div><span>Estimated Shipping</span><b>${money(profit.sellerShippingCost)}</b></div>
        <div class="highlight"><span>Estimated Profit</span><b>${money(profit.netProfit)}</b></div><div class="highlight"><span>ROI</span><b>${pct(profit.roi)}</b></div>
      </div>
      ${item.status !== 'OK' ? `<div class="inlineWarning">eBay Provider partial failure: ${escapeHtml((a.errors || []).join(' / ') || '一部データ不足')}</div>` : ''}
      <div class="cardActions">${deal.productUrl ? `<a class="retailerLink" href="${escapeHtml(deal.productUrl)}" target="_blank" rel="noopener noreferrer">View product</a>` : ''}${button}</div>
      <div class="cardSources"><span>Deal Provider: ${escapeHtml(item.sources?.deal || 'Mock Deal Provider')}</span><span>eBay Provider: ${escapeHtml(item.sources?.ebay || 'eBay Sold Listings API')}</span></div>
    </div>
  </article>`;
}

document.addEventListener('click', event => {
  const add = event.target.closest('.addWatch');
  const remove = event.target.closest('.removeWatch');
  if (add) addToWatchlist(add.dataset.id);
  if (remove) removeFromWatchlist(remove.dataset.id);
});

function readWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]'); } catch { return []; }
}

function writeWatchlist(items) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(items));
  updateWatchCount();
}

function addToWatchlist(id) {
  const item = latestDeals.find(entry => entry.deal?.id === id);
  if (!item) return;
  const items = readWatchlist().filter(entry => entry.deal?.id !== id);
  items.push({ ...item, watch: { addedAt: new Date().toISOString(), alertRules: { priceDrop: true, maximumPrice: item.deal.salePrice, minimumRoi: 40, minimumProfit: 25, availability: true } } });
  writeWatchlist(items);
  document.querySelectorAll(`.addWatch[data-id="${CSS.escape(id)}"]`).forEach(button => { button.textContent = 'Added'; button.disabled = true; });
}

function removeFromWatchlist(id) {
  writeWatchlist(readWatchlist().filter(entry => entry.deal?.id !== id));
  renderWatchlist();
}

function renderWatchlist() {
  const items = readWatchlist();
  $('watchlistEmpty').classList.toggle('hidden', items.length > 0);
  $('watchlistResults').innerHTML = items.map(item => dealCard(item, true)).join('');
  updateWatchCount();
}

function updateWatchCount() { setText('watchCount', readWatchlist().length); }

function renderProductAnalysis(d) {
  const product = d.product || {}, sold = d.sold || {}, active = d.active || {}, market = d.market || {}, profit = d.profit || {}, verdict = d.verdict || {};
  $('result').classList.remove('hidden');
  setText('productName', product.name || '商品名不明'); setText('productMeta', [product.brand, product.model, product.upcGtinEan ? `UPC/GTIN ${product.upcGtinEan}` : null, product.size, product.color].filter(Boolean).join(' · ')); setText('matchConfidence', product.matchConfidence || 'Low');
  setText('verdict', verdict.label || 'MAYBE'); $('verdict').className = `verdict ${String(verdict.label || 'maybe').toLowerCase()}`; setText('verdictReason', (verdict.reasons || []).join(' / '));
  setText('sold7', numberText(sold.count7d)); setText('sold30', numberText(sold.count30d)); setText('sold90', numberText(sold.count90d)); setText('activeCount', numberText(active.count)); setText('sellThrough', pct(market.sellThrough90d)); setText('pace', sold.averageDaysPerSale ? `約${sold.averageDaysPerSale.toFixed(1)}日に1個` : 'データ不足');
  setText('soldMedian', money(sold.stats?.median)); setText('activeMedian', money(active.stats?.median)); setText('targetPrice', money(market.targetSalePrice)); setText('netProfit', money(profit.netProfit)); setText('roi', pct(profit.roi));
  setText('brandOut', product.brand || '不明'); setText('modelOut', product.model || '不明'); setText('upcOut', product.upcGtinEan || '不明'); setText('categoryOut', product.category || '不明'); setText('specOut', (product.specifications || []).join(' / ') || '不明'); setText('searchOut', `${d.search?.strategy || 'none'}: ${d.search?.primary || 'なし'}`);
  setText('soldAvg', money(sold.stats?.average)); setText('soldMin', money(sold.stats?.min)); setText('soldMax', money(sold.stats?.max)); setText('activeAvg', money(active.stats?.average)); setText('activeMin', money(active.stats?.min)); setText('activeMax', money(active.stats?.max)); setText('pace30', sold.pace30Days ? `約${sold.pace30Days.toFixed(1)}日に1個` : 'データ不足'); setText('pace90', sold.pace90Days ? `約${sold.pace90Days.toFixed(1)}日に1個` : 'データ不足'); setText('formula', market.sellThroughFormula || '90日Sold ÷ Active × 100'); setText('priceSource', `${market.targetSalePriceSource || '不明'} / 推定精度 ${market.priceConfidence || 'Low'}`);
  setText('grossCollected', money(profit.grossCollected)); setText('buyerShipping', money(profit.buyerPaidShipping)); setText('costOut', profit.cost == null ? '仕入れ価格不足' : money(profit.cost)); setText('fees', money(profit.estimatedEbayFees)); setText('feeRule', `${Number(profit.feeRate || 0).toFixed(2)}% + ${money(profit.perOrderFee)}`); setText('sellerShipping', money(profit.sellerShippingCost)); setText('shippingLabel', profit.shippingLabel || '推定送料'); setText('weightOut', profit.estimatedWeightLb ? `推定重量 ${profit.estimatedWeightLb.toFixed(1)}lb` : '推定重量なし'); setText('packagingOut', money(profit.packaging)); setText('promotedOut', `${Number(profit.promotedRate || 0).toFixed(1)}% / ${money(profit.promotedCost)}`);
  setText('sourceProduct', d.sources?.product || 'OpenAI Vision'); setText('sourceActive', active.ok ? d.sources?.active : `${d.sources?.active || 'eBay Sold Listings API'}: 取得失敗`); setText('sourceSold', sold.ok ? d.sources?.sold : `${d.sources?.sold || 'eBay Sold Listings API'}: 取得失敗`); setText('updatedAt', d.sources?.updated ? new Date(d.sources.updated).toLocaleString() : '不明');
  renderWarnings(d.warnings || [], d.errors || []); renderListings('activeListings', active.listings || [], false, active.ok); renderListings('soldListings', sold.listings || [], true, sold.ok); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderWarnings(warnings, errors) { const items = [...warnings, ...errors.map(e => `API unavailable: ${e}`)]; $('warnings').innerHTML = items.length ? items.map(x => `<div>${escapeHtml(x)}</div>`).join('') : '<div>警告なし</div>'; }
function renderListings(id, listings, sold, ok) { $(id).innerHTML = listings.length ? listings.map(x => `<li><b>${escapeHtml(x.title || 'Untitled')}</b><span>${money(x.totalPrice)} ${sold && x.soldDate ? `· ${escapeHtml(x.soldDate)}` : ''}</span><small>${[x.condition, x.itemId, x.seller, x.bestOffer ? 'Best Offer' : null].filter(Boolean).map(escapeHtml).join(' / ')}</small></li>`).join('') : `<li><b>${ok ? '0件' : '取得失敗'}</b><span>${ok ? '該当するListingはありません' : 'Providerからデータを取得できませんでした'}</span></li>`; }
function stateMessage(message, type) { return `<div class="emptyState ${escapeHtml(type)}"><h3>${escapeHtml(message)}</h3></div>`; }
async function postJson(url, body) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; }
function setText(id, value) { $(id).textContent = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }

updateWatchCount();
