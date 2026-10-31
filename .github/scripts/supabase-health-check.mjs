import { sendTelegramAlert } from './telegram-alert.mjs';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [0, 2000, 5000];

export async function checkSupabase({ url, key, fetchImpl = fetch, delays = RETRY_DELAYS_MS, timeoutMs = TIMEOUT_MS }) {
  if (!url || !key) throw new Error('Supabase monitor configuration is missing');
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/listings?select=id&limit=1`;
  let lastStatus = 0;

  for (let index = 0; index < delays.length; index++) {
    if (delays[index]) await new Promise((resolve) => setTimeout(resolve, delays[index]));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (response.ok) {
        const rows = await response.json();
        if (Array.isArray(rows)) return { ok: true, attempts: index + 1, status: response.status };
        lastStatus = 502;
      }
    } catch {
      lastStatus = 0;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, attempts: delays.length, status: lastStatus };
}

async function main() {
  const started = Date.now();
  const result = await checkSupabase({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY });
  console.log(JSON.stringify({ event: 'supabase_health_check', ...result, duration_ms: Date.now() - started }));
  if (result.ok) return;

  await sendTelegramAlert(`⚠️ Supabase не отвечает на проверку таблицы listings (HTTP ${result.status || 'network/timeout'}; попыток: ${result.attempts}). Проверьте проект и GitHub Actions.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async () => {
    console.error(JSON.stringify({ event: 'supabase_health_check_failed', reason: 'configuration_or_unexpected_error' }));
    await sendTelegramAlert('⚠️ Не удалось выполнить проверку Supabase. Проверьте GitHub Actions и секреты workflow.');
    process.exitCode = 1;
  });
}
