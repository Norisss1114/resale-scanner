import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderTransport } from '../lib/provider-transport.mjs';

test('transport serializes, deduplicates and expires successful cache entries', async () => {
  let time = 0; let calls = 0; let active = 0; let maximum = 0;
  const client = createProviderTransport({ now: () => time, sleep: async ms => { time += ms; }, interval: 10, ttl: 100,
    fetcher: async () => { calls++; active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return Response.json({ results: [] }); } });
  await Promise.all([client.request('a', 'key'), client.request('a', 'key'), client.request('b', 'key')]);
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal(time, 10);
  await client.request('a', 'key'); assert.equal(calls, 2);
  time = 200; await client.request('a', 'key'); assert.equal(calls, 3);
});

for (const retryAfter of ['120', new Date(120000).toUTCString()]) {
  test(`429 honors Retry-After ${retryAfter} without a retry storm`, async () => {
    let time = 0; let calls = 0;
    const client = createProviderTransport({ now: () => time, sleep: async ms => { time += ms; },
      fetcher: async () => { calls++; return new Response('not JSON', { status: 429, headers: { 'retry-after': retryAfter } }); } });
    await assert.rejects(client.request('a', 'key'), /429/);
    time = 119000;
    await assert.rejects(client.request('b', 'key'), /cooldown/);
    assert.equal(calls, 1);
    time = 120001;
    await assert.rejects(client.request('b', 'key'), /429/);
    assert.equal(calls, 2);
  });
}

test('three failures open circuit, errors are not cached, credentials stay out of errors', async () => {
  let calls = 0;
  const client = createProviderTransport({ sleep: async () => {}, fetcher: async () => { calls++; return new Response('secret credential', { status: 503 }); } });
  for (let i = 0; i < 3; i++) await assert.rejects(client.request('a', 'key'), /503/);
  await assert.rejects(client.request('b', 'key'), /cooldown/);
  assert.equal(calls, 3);
});
