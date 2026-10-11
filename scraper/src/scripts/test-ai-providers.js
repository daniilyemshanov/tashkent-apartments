// Офлайн-тест aiProviders.js на подставном fetch — НЕ ходит в сеть и не
// тратит деньги. Запуск (из scraper/):  node src/scripts/test-ai-providers.js
import assert from 'node:assert/strict';

let n = 0;
async function fresh(env, fetchImpl) {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_EFFORT', 'MISTRAL_API_KEY', 'AI_FALLBACK_ENABLED']) delete process.env[k];
  Object.assign(process.env, env);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    return fetchImpl(url, body, calls.length);
  };
  const mod = await import(`../aiProviders.js?case=${++n}`);
  return { mod, calls };
}
const json = (status, obj, headers = {}) => ({
  ok: status < 400, status,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  text: async () => JSON.stringify(obj),
});
const anthropicOk = (text, extra = {}) => json(200, {
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text }],
  stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 90 }, ...extra,
});
const mistralOk = (text) => json(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 700, completion_tokens: 80 } });
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const origLog = console.log;
const run = (mod, extra = {}) => mod.runAiJsonChain({ taskName: 't', systemPrompt: 'sys', userText: 'usr', maxTokens: 300, ...extra });

const tests = {
  async 'thinking-блок перед текстом + корректный запрос'() {
    const { mod, calls } = await fresh({ ANTHROPIC_API_KEY: 'k' }, () => anthropicOk('```json\n{"rooms":2}\n```'));
    const r = await run(mod);
    assert.equal(r.ok, true); assert.equal(r.provider, 'anthropic'); assert.deepEqual(r.data, { rooms: 2 });
    assert.deepEqual(r.usage, { input: 800, output: 90 });
    const { url, headers, body } = calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(headers['x-api-key'], 'k'); assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.max_tokens, 300 + 1024);
    assert.deepEqual(body.output_config, { effort: 'low' });
    for (const bad of ['temperature', 'top_p', 'top_k']) assert.ok(!(bad in body), `${bad} не должен отправляться`);
    assert.notEqual(body.messages.at(-1).role, 'assistant', 'prefill запрещён');
  },
  async 'повтор при 529, затем успех'() {
    const { mod, calls } = await fresh({ ANTHROPIC_API_KEY: 'k' }, (u, b, i) => i === 1 ? json(529, { error: 'overloaded' }) : anthropicOk('{"ok":true}'));
    const r = await run(mod);
    assert.equal(r.ok, true); assert.equal(calls.length, 2);
  },
  async '401 -> запасной Mistral, Anthropic отключается'() {
    const { mod, calls } = await fresh({ ANTHROPIC_API_KEY: 'bad', MISTRAL_API_KEY: 'm', AI_FALLBACK_ENABLED: 'true' },
      (u) => u.includes('anthropic') ? json(401, { error: 'invalid x-api-key' }) : mistralOk('{"ok":true}'));
    const r1 = await run(mod);
    assert.equal(r1.ok, true); assert.equal(r1.provider, 'mistral');
    const before = calls.length;
    const r2 = await run(mod);
    assert.equal(r2.provider, 'mistral');
    assert.equal(calls.length - before, 1, 'Anthropic не должен вызываться повторно (отключён)');
    assert.deepEqual(mod.providerPlan().map((p) => p.name), ['mistral']);
  },
  async '400 credit balance -> отключение + запасной'() {
    const { mod } = await fresh({ ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'm', AI_FALLBACK_ENABLED: 'true' },
      (u) => u.includes('anthropic') ? json(400, { error: { message: 'Your credit balance is too low to access the Anthropic API.' } }) : mistralOk('{"ok":1}'));
    const r = await run(mod);
    assert.equal(r.provider, 'mistral'); assert.equal(mod.isProviderActiveThisRun('anthropic'), false);
  },
  async 'только thinking без текста (max_tokens) -> запасной'() {
    const { mod } = await fresh({ ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'm', AI_FALLBACK_ENABLED: 'true' },
      (u) => u.includes('anthropic') ? json(200, { content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'max_tokens' }) : mistralOk('{"ok":1}'));
    assert.equal((await run(mod)).provider, 'mistral');
  },
  async 'оба упали -> fallback_exhausted'() {
    const { mod } = await fresh({ ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'm', AI_FALLBACK_ENABLED: 'true' }, () => json(500, { e: 1 }));
    const r = await run(mod);
    assert.equal(r.ok, false); assert.equal(r.reason, 'fallback_exhausted');
  },
  async 'без запасного: bad_response; без ключей: unavailable'() {
    let { mod } = await fresh({ ANTHROPIC_API_KEY: 'k' }, () => json(500, {}));
    assert.equal((await run(mod)).reason, 'bad_response');
    ({ mod } = await fresh({}, () => json(200, {})));
    assert.equal((await run(mod)).reason, 'unavailable');
  },
  async 'ANTHROPIC_EFFORT="" не шлёт output_config'() {
    const { mod, calls } = await fresh({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_EFFORT: '' }, () => anthropicOk('{"a":1}'));
    await run(mod); assert.ok(!('output_config' in calls[0].body));
  },
  async 'невалидный JSON от Anthropic -> запасной'() {
    const { mod } = await fresh({ ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'm', AI_FALLBACK_ENABLED: 'true' },
      (u) => u.includes('anthropic') ? anthropicOk('не json') : mistralOk('{"ok":1}'));
    assert.equal((await run(mod)).provider, 'mistral');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  quiet();
  try { await fn(); Object.assign(console, saved); console.log(`  ok   ${name}`); }
  catch (e) { Object.assign(console, saved); failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(failed ? `\n${failed} тест(ов) упало` : `\nВсе ${Object.keys(tests).length} тестов прошли`);
process.exit(failed ? 1 : 0);
