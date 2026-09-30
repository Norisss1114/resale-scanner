export function budgetLimits(env = {}, priority = 'product') {
  const daily = positive(env.EBAY_PROVIDER_DAILY_REQUEST_LIMIT, 200, 10000);
  const minute = positive(env.EBAY_PROVIDER_MINUTE_REQUEST_LIMIT, 20, 120);
  const fraction = priority === 'scheduled' ? 0.5 : priority === 'manual' ? 0.75 : 1;
  return { daily, minute, usableDaily: Math.floor(daily * fraction), usableMinute: Math.max(1, Math.floor(minute * fraction)) };
}

export async function budgetHealth(env, priority = 'product', time = Date.now()) {
  requireDb(env);
  const row = await env.DB.prepare("SELECT * FROM provider_usage WHERE provider = 'ebay'").first();
  if (!row) throw new Error('Provider budget migration required');
  const limits = budgetLimits(env, priority);
  const used = row.day === new Date(time).toISOString().slice(0, 10) ? row.daily_count : 0;
  return { ...row, limits, remaining: Math.max(0, limits.usableDaily - used), status: row.cooldown_until > time ? 'Cooling Down' : used >= limits.usableDaily ? 'Budget Exhausted' : 'Healthy' };
}

export async function reserveProviderRequest(env, priority = 'product', time = Date.now()) {
  requireDb(env);
  const limits = budgetLimits(env, priority);
  const day = new Date(time).toISOString().slice(0, 10);
  const minute = Math.floor(time / 60000);
  // One atomic write: concurrent isolates cannot both claim the last request.
  const row = await env.DB.prepare(`UPDATE provider_usage SET
    daily_count = CASE WHEN day = ? THEN daily_count + 1 ELSE 1 END,
    minute_count = CASE WHEN minute = ? THEN minute_count + 1 ELSE 1 END,
    day = ?, minute = ?, requests = requests + 1
    WHERE provider = 'ebay' AND cooldown_until <= ?
    AND (day <> ? OR daily_count < ?) AND (minute <> ? OR minute_count < ?)
    RETURNING daily_count, minute_count`).bind(day, minute, day, minute, time, day, limits.usableDaily, minute, limits.usableMinute).first();
  if (!row) throw new Error('Provider budget exhausted or cooling down');
  return row;
}

export async function recordProviderResult(env, { status = 0, ok = false, latency = 0, cooldownUntil = 0 }, time = Date.now()) {
  requireDb(env);
  await env.DB.prepare(`UPDATE provider_usage SET success = success + ?, rate_limited = rate_limited + ?,
    server_errors = server_errors + ?, failures = failures + ?, latency_ms = latency_ms + ?,
    cooldown_until = MAX(cooldown_until, ?, CASE WHEN ? = 0 AND consecutive_failures >= 2 THEN ? ELSE 0 END),
    circuit_open = circuit_open + CASE WHEN ? = 0 AND consecutive_failures = 2 THEN 1 ELSE 0 END,
    consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END
    WHERE provider = 'ebay'`).bind(+ok, +(status === 429), +(status >= 500), +!ok, Math.max(0, latency), cooldownUntil, +ok, time + 30000, +ok, +ok).run();
}

export async function cacheKey(url, credential) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${credential}|${url}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function providerControls(env, priority) {
  requireDb(env);
  return {
    priority,
    beforeRequest: () => reserveProviderRequest(env, priority),
    onResult: result => recordProviderResult(env, result),
    async onCacheHit() { await env.DB.prepare("UPDATE provider_usage SET cache_hits = cache_hits + 1 WHERE provider = 'ebay'").run(); },
    async readCache(key) {
      const row = await env.DB.prepare('SELECT payload FROM provider_cache WHERE cache_key = ? AND expires_at > ?').bind(key, Date.now()).first();
      return row ? JSON.parse(row.payload) : null;
    },
    async writeCache(key, data, expires) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM provider_cache WHERE expires_at <= ?').bind(Date.now()),
        env.DB.prepare('INSERT OR REPLACE INTO provider_cache(cache_key, payload, expires_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(data), expires)
      ]);
    }
  };
}

export function scheduledAnalysisLimit(remaining) { return Math.min(8, Math.max(0, Math.floor(remaining / 2))); }
function requireDb(env) { if (!env.DB?.prepare) throw new Error('D1 required for provider budget'); }
function positive(value, fallback, max) { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback; }
