// Живая проверка ИИ-провайдеров по одному (основной Claude + запасной Mistral).
// Ключи в лог не печатаются. Тратит доли цента.
//
// Запуск (из папки scraper/, Node 18+):
//   node check-ai-providers.mjs                      # читает scraper/.env
//   node check-ai-providers.mjs --env=../client/.env # другой файл
// Чтобы проверить ровно то, что стоит в Vercel, скопируйте значения оттуда
// во временный файл и укажите его через --env.

const envArg = process.argv.find((a) => a.startsWith('--env='));
try {
  const dotenv = await import('dotenv');
  dotenv.config(envArg ? { path: envArg.slice(6) } : {});
} catch {
  console.log('(пакет dotenv не найден — читаю только переменные окружения процесса)');
}

const env = process.env;
const TIMEOUT_MS = 20000;
const SYSTEM = 'Ответь строго JSON-объектом {"ok": true} и больше ничем.';
const secrets = Object.entries(env).filter(([k, v]) => /KEY|TOKEN/.test(k) && v && v.length > 8).map(([, v]) => v);
const redact = (s) => secrets.reduce((acc, v) => acc.split(v).join('***'), String(s));

function hint(status, text = '') {
  if (status === 400 && /credit balance/i.test(text)) return 'НЕТ ДЕНЕГ НА СЧЕТУ — пополните баланс в консоли Anthropic';
  if (status === 401 || status === 403) return 'ключ неверный, отозван или нет прав';
  if (status === 404) return 'модель не найдена / снята с обслуживания';
  if (status === 429) return 'rate limit или исчерпана квота';
  if (status === 400) return 'неверный запрос (имя модели или параметры)';
  if (status === 529) return 'Anthropic перегружен, повторите позже';
  if (status >= 500) return 'сбой на стороне провайдера';
  return '';
}

async function post(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, text: e.name === 'AbortError' ? `таймаут ${TIMEOUT_MS} мс` : e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

function cleanJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  return a >= 0 && b > a ? raw.slice(a, b + 1) : raw;
}

const providers = [
  {
    name: 'anthropic', need: ['ANTHROPIC_API_KEY'], model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    run: (model) => post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 300 + 1024, system: SYSTEM, messages: [{ role: 'user', content: 'ping' }],
        ...((env.ANTHROPIC_EFFORT ?? 'low') ? { output_config: { effort: env.ANTHROPIC_EFFORT ?? 'low' } } : {}) }),
    extract: (j) => (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    extra: (j) => `stop_reason=${j?.stop_reason ?? '?'}, токены in/out=${j?.usage?.input_tokens ?? '?'}/${j?.usage?.output_tokens ?? '?'}`,
  },
  {
    name: 'mistral (запасной)', need: ['MISTRAL_API_KEY'], model: env.MISTRAL_MODEL || 'mistral-small-latest',
    run: (model) => post('https://api.mistral.ai/v1/chat/completions', { Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
      { model, max_tokens: 300, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'ping' }] }),
    extract: (j) => j?.choices?.[0]?.message?.content,
  },
];

console.log('=== Предупреждения по конфигу ===');
const warns = [];
if (env.AI_FALLBACK_ENABLED !== 'true') warns.push('AI_FALLBACK_ENABLED не "true" — запасной Mistral не используется, работает только Claude.');
if (!env.ANTHROPIC_API_KEY) warns.push('ANTHROPIC_API_KEY не задан — основной провайдер выключен.');
if (Number(env.AI_TIMEOUT_MS) > 20000) warns.push(`AI_TIMEOUT_MS=${env.AI_TIMEOUT_MS}: слишком много для Vercel (лимит функции 60 с). Оставьте 15000 или меньше.`);
for (const k of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'SAMBANOVA_API_KEY', 'CLOUDFLARE_API_TOKEN'])
  if (env[k]) warns.push(`${k} больше не используется — можно удалить из .env, Vercel и GitHub Secrets.`);
console.log(warns.length ? warns.map((w) => '! ' + w).join('\n') : 'нет');

console.log('\n=== Живая проверка каждого провайдера ===');
let anyOk = false;
for (const p of providers) {
  const missing = p.need.filter((k) => !env[k]);
  if (missing.length) { console.log(`- ${p.name}: ПРОПУЩЕН (не задано: ${missing.join(', ')})`); continue; }
  const r = await p.run(p.model);
  const text = p.extract(r.json);
  let ok = false, why = '';
  if (r.status !== 200) why = `HTTP ${r.status || 'сеть'} — ${hint(r.status, r.text) || 'см. ответ'}; ${redact(r.text).replace(/\s+/g, ' ').slice(0, 220)}`;
  else if (!text) why = 'пустой ответ (модель потратила лимит токенов на размышления?)';
  else { try { JSON.parse(cleanJson(text)); ok = true; } catch { why = `ответ не JSON: ${redact(text).slice(0, 120)}`; } }
  anyOk ||= ok;
  console.log(`- ${p.name} (${p.model}): ${ok ? 'OK' : 'СБОЙ'} за ${r.ms} мс${p.extra && r.json ? ` [${p.extra(r.json)}]` : ''}${ok ? '' : '\n    ' + why}`);
}
process.exit(anyOk ? 0 : 1);
