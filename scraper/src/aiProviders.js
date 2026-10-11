// ============================================================================
// ИИ-слой проекта: ОДИН платный основной провайдер + ОДИН бесплатный запасной.
//
//   1) Claude Haiku 5.5 (Anthropic)  — основной, платный, быстрый, стабильный
//   2) Mistral (mistral-small-latest) — запасной, бесплатный (опционально)
//
// Раньше здесь была цепочка из шести бесплатных провайдеров (Gemini, Groq,
// OpenRouter, Mistral, SambaNova, Cloudflare) — их ломали квоты, снятые с
// обслуживания модели и 402. Теперь цепочка короткая и предсказуемая.
//
// ВАЖНО: файл существует в ДВУХ копиях, которые должны быть ИДЕНТИЧНЫ
// (разные деплой-юниты, общего import-пути нет):
//   scraper/src/aiProviders.js   — скрапер (GitHub Actions / VPS)
//   client/api/_aiProviders.js   — Vercel (ИИ-поиск на сайте, /search в боте)
// Проверка одной командой из корня репозитория:
//   diff scraper/src/aiProviders.js client/api/_aiProviders.js
//
// Публичный интерфейс не изменился (runAiJsonChain, providerPlan,
// isProviderActiveThisRun) — вызывающий код править не нужно.
//
// Особенности Claude Haiku 5.5 (по официальному migration guide):
//  * temperature/top_p/top_k и prefill ассистента возвращают 400 — НЕ шлём.
//  * Adaptive thinking включён по умолчанию, токены размышления входят в
//    max_tokens, а ответ может начинаться с блока "thinking" — поэтому текст
//    собираем из блоков type:"text", а не берём content[0].
//  * Глубину размышления задаёт output_config.effort ("low" для простых
//    задач извлечения полей — быстрее и дешевле).
// ============================================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

// max_tokens у Anthropic ограничивает размышления + текст. Billing идёт по
// фактически сгенерированным токенам, а не по лимиту, поэтому запас ничего
// не стоит, но защищает от пустого ответа (stop_reason: max_tokens).
const THINKING_HEADROOM_TOKENS = 1024;

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 15000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const ANTHROPIC_MAX_ATTEMPTS = 2; // 1 повтор на 429/5xx/529, потом запасной
const MAX_RETRY_WAIT_MS = 3000;

// Если основной провайдер "лёг" надолго (неверный ключ, кончились деньги,
// повторные 429) — не долбим его на каждом объявлении, а на 10 минут идём
// сразу к запасному. Через 10 минут пробуем снова (в serverless-инстансе
// состояние живёт недолго, в скрапере — не дольше одного прогона).
const DISABLE_FOR_MS = 10 * 60 * 1000;
const RATE_LIMIT_STREAK_LIMIT = 3;
const disabledUntil = new Map(); // name -> timestamp
const rateLimitStreak = new Map(); // name -> число 429 подряд

function cfg() {
  // Читаем ENV в момент вызова (а не при импорте) — проще тестировать и
  // подхватывает значения, заданные после загрузки dotenv.
  return {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    // '' (пустая строка) = не отправлять output_config вообще (на случай,
    // если ANTHROPIC_MODEL переопределён на модель без поддержки effort).
    anthropicEffort: process.env.ANTHROPIC_EFFORT ?? 'low',
    mistralKey: process.env.MISTRAL_API_KEY,
    mistralModel: process.env.MISTRAL_MODEL || 'mistral-small-latest',
    fallbackEnabled: process.env.AI_FALLBACK_ENABLED === 'true',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanJsonText(text) {
  const raw = String(text || '').trim();
  const noFence = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = noFence.indexOf('{');
  const end = noFence.lastIndexOf('}');
  if (start >= 0 && end > start) return noFence.slice(start, end + 1).trim();
  return noFence;
}

function parseJsonResponse(text) {
  return JSON.parse(cleanJsonText(text));
}

async function httpPostJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.response = {
        status: res.status,
        text: bodyText,
        retryAfter: res.headers?.get?.('retry-after') ?? null,
      };
      throw err;
    }
    return JSON.parse(bodyText);
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`timeout ${timeoutMs}ms`);
      e.isTimeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callAnthropic({ systemPrompt, userText, timeoutMs, maxTokens }) {
  const c = cfg();
  const body = {
    model: c.anthropicModel,
    max_tokens: maxTokens + THINKING_HEADROOM_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userText }],
    // Никаких temperature/top_p/top_k и prefill — на Haiku 5.5 это 400.
    ...(c.anthropicEffort ? { output_config: { effort: c.anthropicEffort } } : {}),
  };
  const headers = { 'x-api-key': c.anthropicKey, 'anthropic-version': ANTHROPIC_VERSION };

  let lastError = null;
  for (let attempt = 1; attempt <= ANTHROPIC_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await httpPostJson(ANTHROPIC_URL, headers, body, timeoutMs);
      // Ответ может начинаться с блока thinking — берём только text-блоки.
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (!text.trim()) {
        throw new Error(
          data?.stop_reason === 'max_tokens'
            ? 'max_tokens исчерпан до появления текста (размышления)'
            : `empty response (stop_reason=${data?.stop_reason ?? '?'})`
        );
      }
      return {
        data: parseJsonResponse(text),
        usage: { input: data?.usage?.input_tokens ?? null, output: data?.usage?.output_tokens ?? null },
      };
    } catch (err) {
      lastError = err;
      const status = err?.response?.status;
      // Повторяем только 429/5xx/529. Таймаут не повторяем — это съело бы
      // бюджет времени (на Vercel лимит функции 60 с), идём к запасному.
      const retryable = status && RETRYABLE_STATUSES.has(status);
      if (attempt === ANTHROPIC_MAX_ATTEMPTS || !retryable) break;
      const ra = Number(err.response.retryAfter);
      await sleep(Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600));
    }
  }
  throw lastError || new Error('anthropic failed');
}

async function callMistral({ systemPrompt, userText, timeoutMs, maxTokens }) {
  const c = cfg();
  const data = await httpPostJson(
    MISTRAL_URL,
    { Authorization: `Bearer ${c.mistralKey}` },
    {
      model: c.mistralModel,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    },
    timeoutMs
  );
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty response');
  return {
    data: parseJsonResponse(text),
    usage: { input: data?.usage?.prompt_tokens ?? null, output: data?.usage?.completion_tokens ?? null },
  };
}

function noteFailure(name, err) {
  const status = err?.response?.status;
  const text = String(err?.response?.text || '');

  // Деньги кончились: Anthropic отвечает 400 "credit balance is too low".
  const billing = status === 400 && /credit balance/i.test(text);
  if (status === 401 || status === 403 || billing || status === 402) {
    disabledUntil.set(name, Date.now() + DISABLE_FOR_MS);
    console.error(
      `AI: ${name} отключён на ${DISABLE_FOR_MS / 60000} мин — ` +
        (billing || status === 402
          ? 'НЕТ ДЕНЕГ НА СЧЕТУ, пополните баланс в консоли провайдера'
          : `ключ неверный/отозван (HTTP ${status})`)
    );
    return;
  }
  if (status === 429) {
    const streak = (rateLimitStreak.get(name) || 0) + 1;
    rateLimitStreak.set(name, streak);
    if (streak >= RATE_LIMIT_STREAK_LIMIT) {
      disabledUntil.set(name, Date.now() + DISABLE_FOR_MS);
      rateLimitStreak.set(name, 0);
      console.warn(`AI: ${name} отключён на ${DISABLE_FOR_MS / 60000} мин (повторные 429)`);
    }
    return;
  }
  rateLimitStreak.set(name, 0);
}

function isActive(name) {
  const until = disabledUntil.get(name);
  if (!until) return true;
  if (Date.now() >= until) {
    disabledUntil.delete(name);
    return true;
  }
  return false;
}

export function providerPlan() {
  const c = cfg();
  const plan = [];
  if (c.anthropicKey && isActive('anthropic')) plan.push({ name: 'anthropic', enabled: true });
  if (c.fallbackEnabled && c.mistralKey && isActive('mistral')) plan.push({ name: 'mistral', enabled: true });
  return plan;
}

// Оставлено для совместимости с run.js (раньше решало, нужна ли длинная
// пауза между объявлениями из-за лимитов Gemini).
export function isProviderActiveThisRun(name) {
  return isActive(name);
}

export async function runAiJsonChain({
  taskName,
  systemPrompt,
  userText,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = 300,
}) {
  const plan = providerPlan();
  if (plan.length === 0) {
    return { ok: false, reason: 'unavailable', provider: null };
  }

  const c = cfg();
  const hasFallback = Boolean(c.fallbackEnabled && c.mistralKey);
  let lastError = null;

  for (const provider of plan) {
    try {
      const call = provider.name === 'anthropic' ? callAnthropic : callMistral;
      const { data, usage } = await call({ systemPrompt, userText, timeoutMs, maxTokens });
      rateLimitStreak.set(provider.name, 0);
      console.log(
        `${taskName}: provider ${provider.name} ok` +
          (usage?.input != null ? ` (in ${usage.input} / out ${usage.output} tok)` : '')
      );
      return { ok: true, provider: provider.name, data, usage };
    } catch (err) {
      lastError = err;
      console.warn(`${taskName}: provider ${provider.name} failed (${err?.response?.status || err.message})`);
      noteFailure(provider.name, err);
      await sleep(150);
    }
  }

  return {
    ok: false,
    reason: hasFallback ? 'fallback_exhausted' : 'bad_response',
    provider: null,
    error: lastError?.message || 'all providers failed',
  };
}
