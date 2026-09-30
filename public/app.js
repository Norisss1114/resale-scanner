const $ = id => document.getElementById(id);
const hasNumber = n => n !== null && n !== '' && Number.isFinite(Number(n));
const money = n => hasNumber(n) ? `$${Number(n).toFixed(2)}` : 'N/A';
const numberText = n => hasNumber(n) ? String(n) : 'N/A';
const pct = n => hasNumber(n) ? `${Number(n).toFixed(0)}%` : 'N/A';
const WATCHLIST_KEY = 'resaleScanner.watchlist.v1';
const LOCATION_KEY = 'resaleScanner.location.v1';
let latestDeals = [];

function showAccess() { if (!$('accessDialog').open) $('accessDialog').showModal(); }
$('accessForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    await postJson('/api/session', { password: $('accessPassword').value });
    $('accessPassword').value = ''; $('accessDialog').close(); setText('accessStatus', '');
    loadMonitoring();
  } catch (error) { setText('accessStatus', error.message); }
  finally { button.disabled = false; }
});
getJson('/api/session').catch(error => { showAccess(); setText('accessStatus', error.message); });

document.querySelectorAll('.navButton').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));

function showView(id) {
  document.querySelectorAll('.appView').forEach(view => view.classList.toggle('hidden', view.id !== id));
  document.querySelectorAll('.navButton').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  if (id === 'watchlistView') renderWatchlist();
  if (id === 'dealView') loadMonitoring();
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
      shippingCost: $('shippingCost').value, targetSalePrice: $('targetSalePrice').value,
      minimumProfit: $('productMinimumProfit').value, minimumRoi: $('productMinimumRoi').value, purchaseTaxRate: $('purchaseTaxRate').value
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
$('zipCode').addEventListener('input', saveLocationSettings);
$('radiusMiles').addEventListener('change', saveLocationSettings);

async function scanDeals() {
  $('scanDealsBtn').disabled = true;
  $('dealResults').innerHTML = '';
  $('dealSummary').classList.add('hidden');
  $('localResults').classList.add('hidden');
  const source = document.querySelector('input[name="dealSource"]:checked')?.value || 'live';
  setText('dealStatus', `${source === 'live' ? 'Live Deals' : 'Mock Deals'}を取得し、eBay市場を順番に分析しています...`);
  try {
    const payload = {
      source,
      filters: {
        minimumProfit: $('minimumProfit').value, minimumRoi: $('minimumRoi').value, minimumDiscount: $('minimumDiscount').value,
        retailer: $('retailerFilter').value, sourceType: $('sourceTypeFilter').value, verdict: $('verdictFilter').value,
        inStockOnly: $('inStockOnly').checked, withinRadiusOnly: $('withinRadiusOnly').checked,
        pickupOnly: $('pickupOnly').checked, confirmedOnly: $('confirmedOnly').checked
      },
      location: { zipCode: $('zipCode').value.trim(), radiusMiles: Number($('radiusMiles').value) },
      sortBy: $('dealSort').value
    };
    const data = await postJson('/api/deals/scan', payload);
    latestDeals = data.deals || [];
    renderDealScan(data);
    loadMonitoring();
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
  $('scanTotals').innerHTML = `<strong>${counts.fetched ?? 0} deals scanned</strong><span>${counts.profitable ?? 0} Profitable · ${counts.unprofitable ?? 0} Unprofitable · ${counts.noData ?? 0} No Data · ${counts.lowMatch ?? 0} Low Match · ${counts.providerErrors ?? 0} Provider Errors</span><span>${counts.buy ?? 0} BUY · ${counts.maybe ?? 0} MAYBE · ${counts.skip ?? 0} SKIP</span><span>Potential Profit ${money(counts.potentialProfit)} <small>計算可能な正の利益のみ</small></span><span>条件一致 ${counts.matchedFilters ?? 0}件 · 分析エラー ${counts.errors ?? 0}件</span>`;
  $('providerSummary').innerHTML = (data.providers || []).map(provider => `<div class="providerStatus ${escapeHtml(provider.status)}"><b>${escapeHtml(provider.retailer)}</b><span>${escapeHtml(provider.status)} · ${provider.count ?? 0} deals${provider.error ? ` · ${escapeHtml(provider.error)}` : ''}</span></div>`).join('');
  $('providerSummary').insertAdjacentHTML('beforeend', `<div class="providerStatus"><b>eBay Provider</b><span>${escapeHtml(data.providerHealth?.status || 'Unknown')} · ${data.providerHealth?.remaining ?? 'N/A'} requests remaining · ${data.budgetSkipped ?? 0} deferred</span></div>`);
  renderLocalResults(data);
  if (!counts.fetched) {
    const failed = (data.providers || []).some(provider => ['unavailable', 'error'].includes(provider.status));
    return $('dealResults').innerHTML = stateMessage(failed ? 'Live provider unavailable: 利用可能なDealを取得できませんでした。' : 'Deals 0件: Providerは正常に応答しましたが、Dealはありません。', failed ? 'failure' : 'zero');
  }
  if (!latestDeals.length) return $('dealResults').innerHTML = stateMessage('指定した利益・ROI・割引条件に一致するDealは0件です。', 'zero');
  $('dealResults').innerHTML = latestDeals.map(item => dealCard(item, false)).join('');
}

async function loadMonitoring() {
  try {
    const [opportunities, history, latest] = await Promise.all([
      getJson('/api/opportunities/today'), getJson('/api/scans/history'), getJson('/api/scans/latest')
    ]);
    if (!opportunities.available) return renderMonitoringUnavailable(opportunities.error);
    const summary = opportunities.summary || {};
    $('opportunitySummary').innerHTML = `<div><span>Today's Deals</span><strong>${summary.total || 0}</strong></div><div><span>Strong Buys</span><strong>${summary.strong || 0}</strong></div><div><span>New / Price Drops</span><strong>${summary.newDeals || 0} / ${summary.priceDrops || 0}</strong></div><div><span>Potential Profit</span><strong>${money(summary.potentialProfit)}</strong></div>`;
    $('opportunityResults').innerHTML = (opportunities.opportunities || []).length
      ? opportunities.opportunities.map(opportunityCard).join('')
      : '<div class="monitoringUnavailable">Todayの差分Opportunityはまだありません。</div>';
    renderHistory(history.scans || []);
    setText('latestScanStatus', latest.scan ? `Last automated scan: ${new Date(latest.scan.started_at).toLocaleString()} · ${latest.scan.status}` : 'No automated scans yet');
  } catch (error) {
    renderMonitoringUnavailable(error.message);
  }
}

function renderMonitoringUnavailable(message) {
  $('opportunitySummary').innerHTML = '';
  $('opportunityResults').innerHTML = `<div class="monitoringUnavailable">${escapeHtml(message || 'Automated monitoring unavailable')}</div>`;
  $('scanHistory').innerHTML = '<div class="monitoringUnavailable">Scan history unavailable</div>';
  setText('latestScanStatus', 'Automated monitoring unavailable');
}

function opportunityCard(item) {
  const snapshot = item.snapshot || {};
  const eventLabels = { new_deal: 'NEW', price_drop: 'PRICE DROP', profit_increase: 'PROFIT UP', score_increase: 'SCORE UP', became_buy: 'BECAME BUY', became_strong: 'STRONG', returned: 'RETURNED', availability_improved: 'AVAILABILITY UP' };
  const priceDrop = (item.events || []).find(event => event.eventType === 'price_drop');
  const intelligence = decisionMarkup(snapshot.decisionIntelligence, null);
  return `<article class="opportunityCard"><div class="eventBadges">${(item.events || []).map(event => `<span class="eventBadge">${escapeHtml(eventLabels[event.eventType] || event.eventType)}</span>`).join('')}${item.notificationEligible ? '<span class="eventBadge notify">WOULD NOTIFY</span>' : ''}</div><h3>${escapeHtml(snapshot.title || 'Deal')}</h3><p>${escapeHtml(snapshot.retailer || '')} · Deal Score ${numberText(snapshot.dealScore)} · ${escapeHtml(snapshot.decision || 'N/A')}</p>${priceDrop ? `<div class="priceChange">Was ${money(priceDrop.previousValue)} · Now ${money(priceDrop.currentValue)} · ↓ ${money((priceDrop.metadata || {}).amount)}</div>` : ''}<p>Profit ${money(snapshot.estimatedProfit)} · ROI ${pct(snapshot.roi)} · Local Score ${numberText(snapshot.localScore)}</p>${intelligence}${snapshot.productUrl ? `<a class="retailerLink" href="${escapeHtml(snapshot.productUrl)}" target="_blank" rel="noopener noreferrer">View product</a>` : ''}</article>`;
}

function renderHistory(scans) {
  $('scanHistory').innerHTML = scans.length ? `<table><thead><tr><th>Date</th><th>Trigger</th><th>Status</th><th>Analyzed</th><th>BUY</th><th>New</th><th>Price Drops</th><th>Errors</th></tr></thead><tbody>${scans.map(scan => `<tr><td>${escapeHtml(new Date(scan.started_at).toLocaleString())}</td><td>${escapeHtml(scan.trigger_type)}</td><td>${escapeHtml(scan.status)}</td><td>${scan.analyzed_deals || 0}</td><td>${scan.buy_count || 0}</td><td>${scan.new_count || 0}</td><td>${scan.price_drop_count || 0}</td><td>${scan.error_count || 0}</td></tr>`).join('')}</tbody></table>` : '<div class="monitoringUnavailable">Scan history is empty</div>';
}

function renderLocalResults(data) {
  const location = data.location || {};
  const label = location.status === 'ok'
    ? `${location.city || location.zipCode}, ${location.state || ''} · ${location.radiusMiles} miles`
    : location.status === 'not_set' ? 'Location not set' : `Location unavailable${location.error ? ` · ${location.error}` : ''}`;
  setText('locationStatus', label);
  $('localResults').classList.remove('hidden');
  const stores = data.nearbyStores || [];
  const storeFailures = (data.storeProviders || []).filter(provider => ['unavailable', 'error'].includes(provider.status));
  $('nearbyStores').innerHTML = stores.length
    ? stores.map(store => `<div class="storeRow"><b>${escapeHtml(store.retailer)} · ${escapeHtml(store.name)}</b><span>${Number(store.distanceMiles).toFixed(1)} mi</span><small>${escapeHtml([store.address, store.city, store.state, store.zipCode].filter(Boolean).join(', '))} · ZIP-centroid distance</small></div>`).join('')
    : `<div class="storeRow"><b>${location.status === 'not_set' ? 'Location not set' : 'Nearby stores unavailable'}</b><small>${escapeHtml(storeFailures.map(provider => `${provider.retailer}: Store lookup unavailable`).join(' / ') || '指定半径内の店舗はありません')}</small></div>`;
  $('retailerCapabilities').innerHTML = (data.capabilities || []).map(capability => `<div class="capabilityRow"><b>${escapeHtml(capability.retailer)}</b><span>Deals: ${capabilityMark(capability.deals)} · Stores: ${capabilityMark(capability.stores)} · Pickup: ${escapeHtml(capability.pickup)} · Store Inventory: ${escapeHtml(capability.storeInventory)}</span></div>`).join('');
}

function capabilityMark(value) { return value === 'supported' ? 'Yes' : escapeHtml(value || 'unavailable'); }

function dealCard(item, watchlist) {
  const quality = item.marketConfidence;
  const fresh = quality?.fetchedAt && Date.now() - Date.parse(quality.fetchedAt) <= 15 * 60000;
  if (item.verdict?.label === 'BUY' && (!fresh || !['High', 'Medium'].includes(quality?.level) || quality?.sampleCapped)) item = { ...item, verdict: { label: 'MAYBE', badge: 'VERIFY MATCH', reasons: ['Refresh market data before purchasing.'] } };
  const deal = item.deal || {};
  if (item.status === 'ERROR') return `<article class="dealCard errorCard"><div class="sourceTag">${escapeHtml(deal.source || 'mock')}</div><h3>${escapeHtml(deal.title || 'Deal')}</h3><div class="reasonBadge">API ERROR</div><p class="errorText">Analysis failure: ${escapeHtml(item.error || '不明なエラー')}</p></article>`;
  const a = item.analysis || {};
  const sold = a.sold || {};
  const active = a.active || {};
  const market = a.market || {};
  const profit = a.profit || {};
  const soldState = sold.ok ? (sold.count90d === 0 ? 'Sold 0件' : `${sold.count90d}件`) : 'Sold取得失敗';
  const activeState = active.ok ? `${active.count} matched samples${active.sampleCapped ? ' · capped' : ''}` : 'Active取得失敗';
  const button = watchlist
    ? `<button class="secondary removeWatch" data-id="${escapeHtml(deal.id)}">Remove</button>`
    : `<button class="secondary addWatch" data-id="${escapeHtml(deal.id)}">Add to Watchlist</button>`;
  return `<article class="dealCard">
    <div class="dealMedia">${deal.imageUrl ? `<img src="${escapeHtml(deal.imageUrl)}" alt="${escapeHtml(deal.title)}" loading="lazy" />` : '<div class="imageFallback">NO IMAGE</div>'}<div class="mockFlag">${escapeHtml(deal.sourceType === 'mock' ? 'MOCK' : deal.sourceType || 'LIVE')}</div></div>
    <div class="dealBody">
      <div class="scoreRow"><div class="scorePair"><div><span>DEAL SCORE</span><strong>${item.dealScore?.score ?? 'N/A'}</strong></div><div><span>LOCAL SCORE</span><strong>${item.localScore?.score ?? 'N/A'}</strong></div></div><div><div class="verdict ${String(item.verdict?.label || 'maybe').toLowerCase()}">${escapeHtml(item.verdict?.label || 'MAYBE')}</div>${item.verdict?.badge ? `<div class="reasonBadge">${escapeHtml(item.verdict.badge)}</div>` : ''}</div></div>
      <div class="retailer">${escapeHtml(deal.retailer || 'Unknown retailer')}</div><h3>${escapeHtml(deal.title || 'Untitled deal')}</h3>
      <div class="dealMetrics"><div class="highlight"><span>Profit</span><b>${money(profit.netProfit)}</b></div><div class="highlight"><span>ROI</span><b>${pct(profit.roi)}</b></div></div>
      ${decisionMarkup(a.decisionIntelligence, item.verdict)}
      <details><summary>Market / Matching / Fees</summary>
      <p>Market Data Quality: ${escapeHtml(item.marketConfidence?.level || 'Low')}${item.marketConfidence?.sampleCapped ? ' · Provider sample capped' : ''}</p>
      <details><summary>Match Evidence</summary><pre class="evidence">${escapeHtml(JSON.stringify(item.matchEvidence || {}, null, 2))}</pre></details>
      <div class="matchConfidence ${String(item.matchingConfidence?.level || 'low').toLowerCase().replace(/\s+/g, '-')}">Match: ${escapeHtml(item.matchingConfidence?.label || 'Low')} · Method: ${escapeHtml(formatMatchMethod(item.matchMethod))}${item.matchingConfidence?.level === 'Low' ? ' · Verify' : ''}</div>
      <div class="localAvailability ${escapeHtml(deal.localAvailabilityStatus || 'unknown')}">${localAvailabilityText(deal)}</div>
      <div class="priceLine"><span>Regular <s>${money(deal.regularPrice)}</s></span><strong>${money(deal.salePrice)}</strong><b>${pct(deal.discountPercent)} OFF</b></div>
      <div class="dealMetrics">
        <div><span>eBay Sold Median</span><b>${money(sold.stats?.median)}</b></div><div><span>Sold 7 / 30 / 90</span><b>${numberText(sold.count7d)} / ${numberText(sold.count30d)} / ${soldState}</b></div>
        <div><span>Active</span><b>${activeState}</b></div><div><span>Sell-through</span><b>${pct(market.sellThrough90d)}</b></div>
        <div><span>Estimated Fees</span><b>${money(profit.estimatedEbayFees)}</b></div><div><span>Estimated Shipping</span><b>${money(profit.sellerShippingCost)}</b></div>
      </div>
      <div class="profitReason"><b>${escapeHtml(item.profitStatus || 'ANALYSIS_ERROR')}</b><span>${escapeHtml(item.profitReason || 'Profit diagnostics unavailable.')}</span></div>
      </details>
      <details class="diagnostics"><summary>Why? / Details</summary><div><b>Search query</b><span>${escapeHtml(item.diagnostics?.searchQuery || 'N/A')}</span><b>Match method</b><span>${escapeHtml(formatMatchMethod(item.matchMethod))}</span><b>Match reason</b><span>${escapeHtml(item.matchReason || 'N/A')}</span><b>Matched listings</b><span>Sold ${numberText(item.diagnostics?.soldMatchCount)} / Active ${numberText(item.diagnostics?.activeMatchCount)}</span><b>Market data</b><span>${escapeHtml(item.marketDataStatus || 'N/A')}</span><b>Provider status</b><span>Sold ${escapeHtml(item.diagnostics?.soldProviderStatus || 'N/A')} / Active ${escapeHtml(item.diagnostics?.activeProviderStatus || 'N/A')}</span></div></details>
      ${item.status !== 'OK' ? `<div class="inlineWarning">eBay Provider partial failure: ${escapeHtml((a.errors || []).join(' / ') || '一部データ不足')}</div>` : ''}
      <div class="cardActions">${deal.productUrl ? `<a class="retailerLink" href="${escapeHtml(deal.productUrl)}" target="_blank" rel="noopener noreferrer">View product</a>` : ''}${button}</div>
      <div class="cardSources"><span>Deal Provider: ${escapeHtml(item.sources?.deal || 'Deal Provider')}</span><span>Source: ${escapeHtml(deal.source || 'unknown')} / ${escapeHtml(deal.sourceType || 'unknown')}</span><span>eBay Provider: ${escapeHtml(item.sources?.ebay || 'eBay Sold Listings API')}</span></div>
    </div>
  </article>`;
}

function formatMatchMethod(value) { return ({ upc_exact: 'Exact UPC / GTIN', gtin_exact: 'Exact GTIN', brand_model: 'Brand + Model', brand_sku: 'Brand + SKU / MPN', brand_title: 'Brand + Title', title_tokens: 'Title Tokens', fallback_keywords: 'Fallback Keywords' })[value] || value || 'N/A'; }

function localAvailabilityText(deal) {
  const distance = deal.storeDistanceMiles == null ? null : `${Number(deal.storeDistanceMiles).toFixed(1)} miles away${deal.storeName ? ` at ${deal.storeName}` : ''}`;
  const availability = deal.localAvailabilityStatus === 'confirmed' ? 'Pickup confirmed by retailer'
    : deal.localAvailabilityStatus === 'likely' ? 'Pickup indicated; store-specific availability not confirmed'
      : deal.localAvailabilityStatus === 'unavailable' ? 'Store lookup unavailable' : 'Local availability unknown';
  return [distance, availability, deal.shippingAvailable === true ? 'Shipping indicated' : null].filter(Boolean).join(' · ');
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
  let intelligence = $('productDecision');
  if (!intelligence) { intelligence = document.createElement('div'); intelligence.id = 'productDecision'; $('result').querySelector('.primaryMetrics').after(intelligence); }
  intelligence.innerHTML = decisionMarkup(d.decisionIntelligence, d.verdict);
  let evidence = $('productEvidence');
  if (!evidence) { evidence = document.createElement('details'); evidence.id = 'productEvidence'; $('result').append(evidence); }
  evidence.innerHTML = `<summary>Match: ${escapeHtml(d.matchingConfidence?.level || 'Low')} · Market: ${escapeHtml(d.marketConfidence?.level || 'Low')}</summary><p>Why: ${escapeHtml(d.matchingConfidence?.matchReason || 'No evidence')}</p><p>${escapeHtml((d.marketConfidence?.reasons || []).join(' / '))}</p><pre class="evidence">${escapeHtml(JSON.stringify(d.matchEvidence || {}, null, 2))}</pre>`;
  setText('productName', product.name || '商品名不明'); setText('productMeta', [product.brand, product.model, product.upcGtinEan ? `UPC/GTIN ${product.upcGtinEan}` : null, product.size, product.color].filter(Boolean).join(' · ')); setText('matchConfidence', product.matchConfidence || 'Low');
  setText('verdict', verdict.label || 'MAYBE'); $('verdict').className = `verdict ${String(verdict.label || 'maybe').toLowerCase()}`; setText('verdictReason', (verdict.reasons || []).join(' / '));
  setText('sold7', numberText(sold.count7d)); setText('sold30', numberText(sold.count30d)); setText('sold90', numberText(sold.count90d)); setText('activeCount', numberText(active.count)); setText('sellThrough', pct(market.sellThrough90d)); setText('pace', sold.averageDaysPerSale ? `約${sold.averageDaysPerSale.toFixed(1)}日に1個` : 'データ不足');
  setText('activeCount', `${numberText(active.count)} sampled${active.sampleCapped ? ' · capped' : ''}`);
  setText('soldMedian', money(sold.stats?.median)); setText('activeMedian', money(active.stats?.median)); setText('targetPrice', money(market.targetSalePrice)); setText('netProfit', money(profit.netProfit)); setText('roi', pct(profit.roi));
  setText('brandOut', product.brand || '不明'); setText('modelOut', product.model || '不明'); setText('upcOut', product.upcGtinEan || '不明'); setText('categoryOut', product.category || '不明'); setText('specOut', (product.specifications || []).join(' / ') || '不明'); setText('searchOut', `${d.search?.strategy || 'none'}: ${d.search?.primary || 'なし'}`);
  setText('soldAvg', money(sold.stats?.average)); setText('soldMin', money(sold.stats?.min)); setText('soldMax', money(sold.stats?.max)); setText('activeAvg', money(active.stats?.average)); setText('activeMin', money(active.stats?.min)); setText('activeMax', money(active.stats?.max)); setText('pace30', sold.pace30Days ? `約${sold.pace30Days.toFixed(1)}日に1個` : 'データ不足'); setText('pace90', sold.pace90Days ? `約${sold.pace90Days.toFixed(1)}日に1個` : 'データ不足'); setText('formula', market.sellThroughFormula || '90日Sold ÷ Active × 100'); setText('priceSource', `${market.targetSalePriceSource || '不明'} / 推定精度 ${market.priceConfidence || 'Low'}`);
  setText('grossCollected', money(profit.grossCollected)); setText('buyerShipping', money(profit.buyerPaidShipping)); setText('costOut', profit.cost == null ? '仕入れ価格不足' : money(profit.cost)); setText('fees', money(profit.estimatedEbayFees)); setText('feeRule', `${Number(profit.feeRate || 0).toFixed(2)}% + ${money(profit.perOrderFee)}`); setText('sellerShipping', money(profit.sellerShippingCost)); setText('shippingLabel', profit.shippingLabel || '推定送料'); setText('weightOut', profit.estimatedWeightLb ? `推定重量 ${profit.estimatedWeightLb.toFixed(1)}lb` : '推定重量なし'); setText('packagingOut', money(profit.packaging)); setText('promotedOut', `${Number(profit.promotedRate || 0).toFixed(1)}% / ${money(profit.promotedCost)}`);
  setText('sourceProduct', d.sources?.product || 'OpenAI Vision'); setText('sourceActive', active.ok ? d.sources?.active : `${d.sources?.active || 'eBay Sold Listings API'}: 取得失敗`); setText('sourceSold', sold.ok ? d.sources?.sold : `${d.sources?.sold || 'eBay Sold Listings API'}: 取得失敗`); setText('updatedAt', d.sources?.updated ? new Date(d.sources.updated).toLocaleString() : '不明');
  renderWarnings(d.warnings || [], d.errors || []); renderListings('activeListings', active.listings || [], false, active.ok); renderListings('soldListings', sold.listings || [], true, sold.ok); $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function decisionMarkup(decision, verdict) {
  const d = decision?.schemaVersion === 1 ? decision : null, e = d?.economics;
  return `<div class="dealMetrics decisionMetrics"><div><span>Max Buy Price</span><b>${money(e?.maxBuyPrice)}</b></div><div><span>Risk</span><b>${escapeHtml(d?.risk?.level || 'N/A')}</b></div></div>
    <p class="reason">${escapeHtml((verdict?.reasons || []).join(' / '))}</p>
    <details><summary>Purchase targets / Risk details</summary>
    <div class="dealMetrics"><div><span>Break-even item price</span><b>${money(e?.breakEvenSalePrice)}</b></div><div><span>Required item price (both targets)</span><b>${money(e?.requiredSalePrice)}</b></div>
    <div><span>Profit target</span><b>${money(e?.minimumProfit)}</b></div><div><span>ROI target</span><b>${pct(e?.minimumRoi)}</b></div>
    <div><span>Purchase tax assumption</span><b>${pct(e?.purchaseTaxRate)}</b></div><div><span>Price volatility</span><b>${escapeHtml(d?.volatility?.level || 'N/A')}</b></div>
    <div><span>Sample competition</span><b>${escapeHtml(d?.saturation || 'N/A')}</b></div><div><span>Days to sell</span><b>N/A</b></div></div>
    <p>${escapeHtml(e?.maxBuyReason || '')}</p><ul>${(d?.risk?.reasons || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    <p>${escapeHtml(d?.holdingPeriodReason || 'No decision intelligence in this snapshot')}</p>
    <p>${escapeHtml((d?.assumptions || []).join('. '))}</p></details>`;
}

function renderWarnings(warnings, errors) { const items = [...warnings, ...errors.map(e => `API unavailable: ${e}`)]; $('warnings').innerHTML = items.length ? items.map(x => `<div>${escapeHtml(x)}</div>`).join('') : '<div>警告なし</div>'; }
function renderListings(id, listings, sold, ok) { $(id).innerHTML = listings.length ? listings.map(x => `<li><b>${escapeHtml(x.title || 'Untitled')}</b><span>${money(x.totalPrice)} ${sold && x.soldDate ? `· ${escapeHtml(x.soldDate)}` : ''}</span><small>${[x.condition, x.itemId, x.seller, x.bestOffer ? 'Best Offer' : null].filter(Boolean).map(escapeHtml).join(' / ')}</small></li>`).join('') : `<li><b>${ok ? '0件' : '取得失敗'}</b><span>${ok ? '該当するListingはありません' : 'Providerからデータを取得できませんでした'}</span></li>`; }
function stateMessage(message, type) { return `<div class="emptyState ${escapeHtml(type)}"><h3>${escapeHtml(message)}</h3></div>`; }
async function postJson(url, body) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (response.status === 401) showAccess(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; }
async function getJson(url) { const response = await fetch(url); const data = await response.json(); if (response.status === 401) showAccess(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; }
function setText(id, value) { $(id).textContent = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }

function saveLocationSettings() {
  const settings = { zipCode: $('zipCode').value.replace(/\D/g, '').slice(0, 5), radiusMiles: Number($('radiusMiles').value) || 15 };
  $('zipCode').value = settings.zipCode;
  localStorage.setItem(LOCATION_KEY, JSON.stringify(settings));
  setText('locationStatus', settings.zipCode ? `ZIP ${settings.zipCode} · saved` : 'Location not set');
}

function loadLocationSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(LOCATION_KEY) || '{}');
    $('zipCode').value = /^\d{5}$/.test(settings.zipCode || '') ? settings.zipCode : '';
    $('radiusMiles').value = ['5', '10', '15', '25', '50'].includes(String(settings.radiusMiles)) ? String(settings.radiusMiles) : '15';
    setText('locationStatus', $('zipCode').value ? `ZIP ${$('zipCode').value} · saved` : 'Location not set');
  } catch { setText('locationStatus', 'Location not set'); }
}

loadLocationSettings();
updateWatchCount();
loadMonitoring();
