import { cacheKey as digestCacheKey } from './provider-budget.mjs';
// Local queue plus atomic D1 admission for every actual paid request.
export function createProviderTransport({ fetcher = (...args) => fetch(...args), now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), interval = 1200, ttl = 300000 } = {}) {
  const queue = [];
  let running = false;
  function enqueue(run, priority) {
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject, rank: { product: 0, manual: 1, scheduled: 2 }[priority] ?? 0 });
      if (running) return;
      running = true;
      queueMicrotask(async () => {
        while (queue.length) {
          queue.sort((a, b) => a.rank - b.rank);
          const job = queue.shift();
          try { job.resolve(await job.run()); } catch (error) { job.reject(error); }
        }
        running = false;
      });
    });
  }
  let nextAt = 0;
  let blockedUntil = 0;
  let consecutiveFailures = 0;
  const exhaustedCredentials = new Set();
  const cache = new Map();
  const pending = new Map();
  const metrics = { requests: 0, hits: 0, rateLimited: 0, failures: 0, totalLatencyMs: 0 };
  return {
    metrics,
    async request(url, key, controls = {}) {
      const cacheKey = await digestCacheKey(url, key);
      const pendingKey = `${cacheKey}|${controls.priority || 'product'}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expires > now()) { metrics.hits++; await controls.onCacheHit?.(); return cached.data; }
      if (pending.has(pendingKey)) return pending.get(pendingKey);
      if (pending.size >= 32) return Promise.reject(new Error('Provider queue capacity reached'));
      const task = enqueue(async () => {
        const ready = cache.get(cacheKey);
        if (ready && ready.expires > now()) { metrics.hits++; await controls.onCacheHit?.(); return ready.data; }
        const shared = await controls.readCache?.(cacheKey);
        if (shared) { metrics.hits++; await controls.onCacheHit?.(); return shared; }
        if (!controls.beforeRequest && exhaustedCredentials.has(key)) throw new Error('Monthly provider quota exhausted');
        if (now() < blockedUntil) throw new Error('Provider rate limited: cooldown active');
        await sleep(Math.max(0, nextAt - now()));
        await controls.beforeRequest?.();
        const started = now();
        let status = 0; let ok = false; let cooldownUntil = 0;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 18000);
        metrics.requests++;
        try {
          const response = await fetcher(url, { headers: { authorization: `Bearer ${key}` }, signal: controller.signal });
          status = response.status;
          if (status === 402) {
            if (!controls.beforeRequest) exhaustedCredentials.add(key);
            await response.body?.cancel();
            throw new Error('Provider unavailable (402): Monthly provider quota exhausted');
          }
          if (response.status === 429) {
            metrics.rateLimited++;
            const header = response.headers.get('retry-after');
            const seconds = header == null ? NaN : Number(header);
            const until = Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(header);
            blockedUntil = Math.max(now() + 60000, Number.isFinite(until) ? until : 0);
            cooldownUntil = blockedUntil;
            await response.body?.cancel();
            throw new Error('Provider unavailable (429): rate limited; retry after cooldown');
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Provider unavailable (${response.status})`);
          }
          const raw = await response.json();
          const data = cacheablePayload(raw);
          data.retrievedAt = new Date(now()).toISOString();
          ok = true;
          consecutiveFailures = 0;
          for (const [id, entry] of cache) if (entry.expires <= now()) cache.delete(id);
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          await controls.writeCache?.(cacheKey, data, now() + ttl);
          cache.set(cacheKey, { data, expires: now() + ttl });
          return data;
        } catch (error) {
          metrics.failures++;
          if (++consecutiveFailures >= 3) blockedUntil = Math.max(blockedUntil, now() + 30000);
          const safeMessage = /^Provider (?:unavailable \(\d+\)|returned invalid results)/.test(error.message) ? error.message : 'Provider request failed';
          throw new Error(error.name === 'AbortError' ? 'Provider timeout' : safeMessage);
        } finally {
          clearTimeout(timeout);
          metrics.totalLatencyMs += now() - started;
          nextAt = now() + interval;
          await controls.onResult?.({ status, ok, latency: now() - started, cooldownUntil });
        }
      }, controls.priority);
      pending.set(pendingKey, task);
      task.finally(() => pending.delete(pendingKey)).catch(() => {});
      return task;
    }
  };
}

function cacheablePayload(raw) {
  if (!Array.isArray(raw?.results) || raw.results.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('Provider returned invalid results');
  const fields = ['title', 'totalPrice', 'soldPrice', 'currentPrice', 'price', 'value', 'shippingPrice', 'shipping', 'shippingCost', 'soldDate', 'dateSold', 'endedAt', 'condition', 'itemId', 'id', 'url', 'itemWebUrl', 'bestOffer', 'best_offer', 'isBestOffer', 'buyingFormat', 'sellerUsername', 'gtin', 'upc', 'ean', 'mpn', 'model', 'brand', 'thumbnailUrl'];
  return {
    count: Math.max(Number(raw.count) || 0, raw.results.length),
    results: raw.results.slice(0, 240).map(item => {
      const clean = {};
      for (const field of fields) if (['string', 'number', 'boolean'].includes(typeof item[field])) clean[field] = typeof item[field] === 'string' ? item[field].slice(0, 2000) : item[field];
      if (!clean.sellerUsername && typeof item.seller?.username === 'string') clean.sellerUsername = item.seller.username.slice(0, 200);
      return clean;
    })
  };
}
