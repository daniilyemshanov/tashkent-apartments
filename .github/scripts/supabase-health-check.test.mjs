import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSupabase } from './supabase-health-check.mjs';

test('health check retries temporary failures and confirms a real listings response', async () => {
  let calls = 0;
  const result = await checkSupabase({
    url: 'https://example.supabase.co', key: 'test-key', delays: [0, 0, 0],
    fetchImpl: async (url, options) => {
      calls++;
      assert.match(url, /\/rest\/v1\/listings\?select=id&limit=1$/);
      assert.equal(options.headers.apikey, 'test-key');
      return calls < 3 ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => [] };
    },
  });
  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  assert.equal(calls, 3);
});

test('health check returns a bounded failure result after all attempts', async () => {
  let calls = 0;
  const result = await checkSupabase({
    url: 'https://example.supabase.co', key: 'test-key', delays: [0, 0],
    fetchImpl: async () => { calls++; return { ok: false, status: 503 }; },
  });
  assert.deepEqual(result, { ok: false, attempts: 2, status: 503 });
  assert.equal(calls, 2);
});


test('health check aborts timed-out requests and does not exceed its retry bound', async () => {
  let calls = 0;
  const result = await checkSupabase({
    url: 'https://example.supabase.co', key: 'test-key', delays: [0, 0], timeoutMs: 5,
    fetchImpl: (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  assert.deepEqual(result, { ok: false, attempts: 2, status: 0 });
  assert.equal(calls, 2);
});
