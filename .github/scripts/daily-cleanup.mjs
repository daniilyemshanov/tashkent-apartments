// Ежедневная чистка базы Supabase (см. supabase/18_storage_diet.sql) и
// проверка её размера. Вызывает RPC public.daily_cleanup() повторно, пока
// есть что обрабатывать (каждый вызов — ограниченная пачка строк).
//
// Режим по умолчанию — ПРОБНЫЙ (dry run): только считает, что было бы
// сделано, и ничего не меняет. Реальная очистка включается переменной
// DAILY_CLEANUP_LIVE=true (в GitHub: Settings → Variables → Actions).
//
// Если размер базы больше DB_SIZE_ALERT_MB (по умолчанию 350 из 500 МБ
// бесплатного плана) — шлёт предупреждение в админский Telegram-чат.
import { pathToFileURL } from 'node:url';
import { sendTelegramAlert } from './telegram-alert.mjs';

const TIMEOUT_MS = 60000;
const MAX_ROUNDS = 40;
const MB = 1024 * 1024;

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

async function callRpc(baseUrl, key, args, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/daily_cleanup`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`daily_cleanup RPC HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {{rpc: (args: object) => Promise<object>, live: boolean, args: object, maxRounds?: number}} opts
 * @returns {Promise<{rounds: number, totals: object, last: object}>}
 */
export async function runCleanup({ rpc, live, args, maxRounds = MAX_ROUNDS }) {
  const totals = { slimmed: 0, trimmed: 0, purged: 0 };
  let last = null;
  let rounds = 0;
  do {
    last = await rpc({ ...args, p_dry_run: !live });
    rounds++;
    totals.slimmed += last.slimmed || 0;
    totals.trimmed += last.trimmed || 0;
    totals.purged += last.purged || 0;
    // В пробном режиме одного вызова достаточно — он ничего не меняет.
    if (!live) break;
  } while (rounds < maxRounds && (last.slimmed || last.trimmed || last.purged));
  return { rounds, totals, last };
}

async function main() {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !key) throw new Error('Missing Supabase workflow secrets');

  const live = process.env.DAILY_CLEANUP_LIVE === 'true';
  const args = {
    p_keep_days: intFromEnv('KEEP_DAYS', 14),
    p_keep_agent_days: intFromEnv('KEEP_AGENT_DAYS', 30),
    p_text_days: intFromEnv('TEXT_DAYS', 7),
    p_batch_size: intFromEnv('CLEANUP_BATCH_SIZE', 2000),
  };
  const alertMb = intFromEnv('DB_SIZE_ALERT_MB', 350);

  const { rounds, totals, last } = await runCleanup({
    rpc: (rpcArgs) => callRpc(baseUrl, key, rpcArgs),
    live,
    args,
  });

  const dbMb = Math.round((last.db_bytes || 0) / MB);
  const listingsMb = Math.round((last.listings_bytes || 0) / MB);
  console.log(JSON.stringify({
    event: 'daily_cleanup',
    mode: live ? 'live' : 'dry_run',
    rounds,
    ...(live
      ? totals
      : {
          would_slim: last.slim_candidates,
          would_trim: last.trim_candidates,
          would_purge: last.purge_candidates,
        }),
    db_mb: dbMb,
    listings_mb: listingsMb,
  }));

  if (dbMb >= alertMb) {
    await sendTelegramAlert(
      `⚠️ База Supabase занимает ${dbMb} МБ (лимит бесплатного плана — 500 МБ, порог предупреждения — ${alertMb} МБ; таблица объявлений — ${listingsMb} МБ). ` +
        (live
          ? 'Автоочистка включена — если размер продолжает расти, уменьшите KEEP_DAYS.'
          : 'Автоочистка работает в пробном режиме: включите её, задав переменную DAILY_CLEANUP_LIVE=true в GitHub Actions.')
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const missing = error?.status === 404;
    console.error(JSON.stringify({
      event: 'daily_cleanup_failed',
      reason: error?.name === 'AbortError' ? 'timeout' : missing ? 'function_missing' : 'request_or_configuration_error',
    }));
    await sendTelegramAlert(
      missing
        ? '⚠️ Ежедневная чистка базы не запустилась: в Supabase нет функции daily_cleanup. Выполните supabase/18_storage_diet.sql в SQL Editor.'
        : '⚠️ Ежедневная чистка базы Supabase завершилась ошибкой. Проверьте GitHub Actions → Daily cleanup.'
    );
    process.exitCode = 1;
  });
}
