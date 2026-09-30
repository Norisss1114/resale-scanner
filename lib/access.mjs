const encoder = new TextEncoder();
const COOKIE = '__Host-resale_session';
export const accessError = (message, status) => Object.assign(new Error(message), { status });

export async function consumeLimit(env, scope, limit, windowMs, time = Date.now()) {
  if (!env.DB?.prepare) throw accessError('Access control database unavailable', 503);
  const bucket = Math.floor(time / windowMs);
  const row = await env.DB.prepare(`INSERT INTO request_limits(scope,bucket,count) VALUES (?,?,1)
    ON CONFLICT(scope) DO UPDATE SET bucket = excluded.bucket,
    count = CASE WHEN request_limits.bucket = excluded.bucket THEN request_limits.count + 1 ELSE 1 END
    WHERE request_limits.bucket <> excluded.bucket OR request_limits.count < ? RETURNING count`).bind(scope, bucket, limit).first();
  if (!row) throw accessError('Request limit reached; try again later', 429);
}

export function sameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw accessError('Same-origin request required', 403);
}

async function signingKey(env) {
  if (typeof env.APP_ACCESS_PASSWORD !== 'string' || env.APP_ACCESS_PASSWORD.length < 20 || env.APP_ACCESS_PASSWORD.length > 256) throw accessError('APP_ACCESS_PASSWORD (20-256 characters) required', 503);
  return crypto.subtle.importKey('raw', encoder.encode(env.APP_ACCESS_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueSession(env, password, time = Date.now()) {
  const key = await signingKey(env);
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(env.APP_ACCESS_PASSWORD));
  if (typeof password !== 'string' || password.length > 256 || !await crypto.subtle.verify('HMAC', key, expected, encoder.encode(password))) throw accessError('Incorrect passphrase', 401);
  const payload = `${time + 12 * 3600000}.${crypto.randomUUID()}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${Array.from(signature, b => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function requireSession(request, env, time = Date.now()) {
  const key = await signingKey(env);
  const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= time || Number(parts[0]) > time + 12 * 3600000 || !/^[a-f0-9]{64}$/.test(parts[2])) throw accessError('Unlock Resale Scanner to continue', 401);
  const signature = Uint8Array.from(parts[2].match(/../g), x => parseInt(x, 16));
  if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts.slice(0, 2).join('.')))) throw accessError('Invalid session', 401);
}

export function sessionCookie(token) { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`; }

export async function limitedJson(request, maxBytes = 10000000) {
  if (!request.body) throw accessError('JSON body required', 400);
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw accessError('Request body too large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw accessError('Invalid JSON object', 400); }
}
