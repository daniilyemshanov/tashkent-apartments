// Курс USD→UZS для ИИ-чата: официальный курс ЦБ Узбекистана (JSON API cbu.uz).
// Кэш в памяти serverless-инстанса на 6 часов (ЦБ обновляет курс раз в день).
// Если ЦБ недоступен: сначала берём последний удачный курс из кэша, потом EXCHANGE_RATE_USD_UZS из env.

const CBU_URL = 'https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/';
const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cache = null; // { rate, date, ts }

/** @returns {Promise<{rate:number, date:string|null, source:'cbu'|'cbu_stale'|'env'}|null>} */
export async function getUsdRate() {
  if (cache && Date.now() - cache.ts < TTL_MS) return { rate: cache.rate, date: cache.date, source: 'cbu' };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CBU_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`CBU HTTP ${res.status}`);
    const arr = await res.json();
    const row = Array.isArray(arr) ? arr.find((x) => x?.Ccy === 'USD') || arr[0] : null;
    const nominal = Number(row?.Nominal) || 1;
    const rate = Number(String(row?.Rate ?? '').replace(',', '.')) / nominal;
    if (!Number.isFinite(rate) || rate < 5000 || rate > 30000) throw new Error(`CBU rate out of range: ${row?.Rate}`);
    cache = { rate, date: row?.Date || null, ts: Date.now() };
    return { rate, date: cache.date, source: 'cbu' };
  } catch (err) {
    console.warn('getUsdRate: ЦБ недоступен:', err.message);
    if (cache) return { rate: cache.rate, date: cache.date, source: 'cbu_stale' };
    const envRate = Number(process.env.EXCHANGE_RATE_USD_UZS);
    return Number.isFinite(envRate) && envRate > 0 ? { rate: envRate, date: null, source: 'env' } : null;
  } finally {
    clearTimeout(t);
  }
}
