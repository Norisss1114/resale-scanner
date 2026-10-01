export function budgetLimits(env = {}, priority = 'product') {
  const daily = positive(env.EBAY_PROVIDER_DAILY_REQUEST_LIMIT, 80, 10000);
  const minute = positive(env.EBAY_PROVIDER_MINUTE_REQUEST_LIMIT, 20, 120);
  const fraction = priority === 'scheduled' ? 0.5 : priority === 'manual' ? 0.75 : 1;
  return { daily, minute, usableDaily: Math.floor(daily * fraction), usableMinute: Math.max(1, Math.floor(minute * fraction)) };
}

export function quotaLimits(env = {}, priority = 'product') {
  const limit = positive(env.EBAY_PROVIDER_QUOTA_LIMIT, 3000, 1000000);
  const date = env.EBAY_PROVIDER_QUOTA_RESET_AT;
  const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(date) ? Date.parse(date) : NaN;
  return { limit, usable: Math.floor(limit * (priority === 'scheduled' ? 0.15 : priority === 'manual' ? 0.4 : 1)),
    resetAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null, invalid: Boolean(date) && !Number.isFinite(parsed) };
}

async function syncQuota(env, priority, time) {
  const quota = quotaLimits(env, priority), now = new Date(time).toISOString();
  if (quota.resetAt && quota.resetAt > now) {
    // Advance only an expired, explicitly configured period. Editing a future date cannot refund usage.
    await env.DB.prepare(`UPDATE provider_usage SET quota_count = CASE WHEN quota_epoch <> '' THEN 0 ELSE quota_count END,
      quota_exhausted = CASE WHEN quota_epoch <> '' THEN 0 ELSE quota_exhausted END, quota_epoch = ?
      WHERE provider = 'ebay' AND (quota_epoch = '' OR (quota_epoch <= ? AND quota_epoch <> ?))`)
      .bind(quota.resetAt, now, quota.resetAt).run();
  }
  return quota;
}

export async function budgetHealth(env, priority = 'product', time = Date.now()) {
  requireDb(env);
  const quota = await syncQuota(env, priority, time);
  const row = await env.DB.prepare("SELECT * FROM provider_usage WHERE provider = 'ebay'").first();
  if (!row) throw new Error('Provider budget migration required');
  const limits = budgetLimits(env, priority);
  const used = row.day === new Date(time).toISOString().slice(0, 10) ? row.daily_count : 0;
  const expired = quota.invalid || (quota.resetAt && Date.parse(quota.resetAt) <= time) || (row.quota_epoch && Date.parse(row.quota_epoch) <= time);
  const quotaRemaining = row.quota_exhausted || expired ? 0 : Math.max(0, quota.usable - row.quota_count);
  return { ...row, limits, quota: { limit: quota.limit, used: row.quota_count, remaining: quotaRemaining, resetAt: row.quota_epoch || quota.resetAt || null,
      resetConfirmationRequired: Boolean(expired), configured: Boolean(quota.resetAt) },
    remaining: Math.min(Math.max(0, limits.usableDaily - used), quotaRemaining),
    status: row.quota_exhausted || quotaRemaining === 0 ? 'Quota exhausted' : row.cooldown_until > time ? 'Cooling Down' : used >= limits.usableDaily ? 'Budget Exhausted' : 'Healthy' };
}

export async function reserveProviderRequest(env, priority = 'product', time = Date.now()) {
  requireDb(env);
  const quota = await syncQuota(env, priority, time);
  if (quota.invalid || (quota.resetAt && Date.parse(quota.resetAt) <= time)) throw new Error('Monthly provider quota exhausted; confirm billing reset configuration');
  const limits = budgetLimits(env, priority);
  const day = new Date(time).toISOString().slice(0, 10);
  const minute = Math.floor(time / 60000);
  // One atomic write: concurrent isolates cannot both claim the last request.
  const row = await env.DB.prepare(`UPDATE provider_usage SET
    daily_count = CASE WHEN day = ? THEN daily_count + 1 ELSE 1 END,
    minute_count = CASE WHEN minute = ? THEN minute_count + 1 ELSE 1 END,
    day = ?, minute = ?, requests = requests + 1, quota_count = quota_count + 1
    WHERE provider = 'ebay' AND cooldown_until <= ?
    AND quota_exhausted = 0 AND quota_count < ? AND (quota_epoch = '' OR quota_epoch > ?)
    AND (day <> ? OR daily_count < ?) AND (minute <> ? OR minute_count < ?)
    RETURNING daily_count, minute_count`).bind(day, minute, day, minute, time, quota.usable, new Date(time).toISOString(), day, limits.usableDaily, minute, limits.usableMinute).first();
  if (!row) {
    const health = await budgetHealth(env, priority, time);
    throw new Error(health.status === 'Quota exhausted' ? 'Monthly provider quota exhausted' : 'Provider budget exhausted or cooling down');
  }
  return row;
}

export async function recordProviderResult(env, { status = 0, ok = false, latency = 0, cooldownUntil = 0 }, time = Date.now()) {
  requireDb(env);
  if (status === 402) await env.DB.prepare("UPDATE provider_usage SET quota_exhausted = 1 WHERE provider = 'ebay'").run();
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
