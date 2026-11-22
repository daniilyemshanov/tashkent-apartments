// Инструменты ИИ-чата по базе: search_listings и market_stats.
// Те же правила, что в listings.js (агентства и дубли скрыты). Результат сжат до минимума токенов
// и обогащён тем, что скрапер уже посчитал (цена за м², отклонение от рынка, снижения цены,
// новостройка/вторичка), чтобы ИИ мог оценивать объекты, а не просто пересказывать.

import { supabase } from './_supabase.js';
import { DISTRICTS } from '../src/districts.js';
import { getUsdRate } from './_fx.js';

const MAX_RESULTS = 8;
const SNIPPET_CHARS = 500;
const MIN_MARKET_SAMPLE = 8; // медиана по меньшей выборке — не основание для слов «дорого/дёшево» // кусок описания: по нему ИИ судит о ремонте, этаже, документах

export const SEARCH_TOOL = {
  name: 'search_listings',
  description:
    'Ищет объявления в базе. Бюджет можно задать в любой валюте: поиск сам находит и объявления в $, и в сумах (пересчёт по курсу ЦБ). ' +
    'Вызывай несколько раз при необходимости. Возвращает до 8 объявлений с ценой в $, ценой за м², оценкой относительно рынка, фрагментом описания и ссылкой.',
  input_schema: {
    type: 'object',
    properties: {
      district: { type: 'array', items: { type: 'string', enum: DISTRICTS }, description: 'Районы (только из списка)' },
      deal: { type: 'string', enum: ['sale', 'rent'] },
      type: { type: 'string', enum: ['apartment', 'house', 'commercial'] },
      rooms: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 5 }, description: '5 означает 5 и больше' },
      priceMin: { type: 'number' },
      priceMax: { type: 'number' },
      currency: { type: 'string', enum: ['USD', 'UZS'], description: 'В какой валюте заданы priceMin/priceMax (как сказал человек)' },
      areaMin: { type: 'number', description: 'Площадь от, м²' },
      areaMax: { type: 'number', description: 'Площадь до, м²' },
      segment: { type: 'string', enum: ['new_build', 'secondary'], description: 'Новостройка или вторичка (определено не у всех объявлений)' },
      ownerOnly: { type: 'boolean', description: 'Только от собственника' },
      text: { type: 'string', description: 'Слова в заголовке/описании: «евроремонт», «ЖК Мирабад». Фильтр жёсткий — по умолчанию не используй' },
      sort: { type: 'string', enum: ['new', 'price_asc', 'price_desc', 'best_deal'], description: 'best_deal — лучшая оценка выгодности (deal_score)' },
      excludeIds: { type: 'array', items: { type: 'string' }, description: 'id уже показанных объявлений — не повторять' },
    },
  },
};

export const MARKET_TOOL = {
  name: 'market_stats',
  description:
    'Медианная цена за м² в $ по районам из НАШЕЙ базы за ~45 дней и размер выборки. Для вопросов про районы и сравнение районов. ' +
    'Пустой ответ или sample < 8 означает, что данных нет и оценивать рынок нельзя. Для оценки конкретного объявления используй поле market из search_listings.',
  input_schema: {
    type: 'object',
    properties: {
      deal: { type: 'string', enum: ['sale', 'rent'] },
      type: { type: 'string', enum: ['apartment', 'house', 'commercial'] },
      district: { type: 'string', enum: DISTRICTS },
    },
  },
};

const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);
const round = (n, step = 1) => (Number.isFinite(n) ? Math.round(n / step) * step : null);
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

/** Ссылка на пост с этим объявлением в нашей группе (если он там есть и не удалён). */
export function telegramPostLink(r) {
  if (!r.telegram_chat_id || !r.telegram_message_id || r.telegram_deleted) return null;
  const internal = String(r.telegram_chat_id).replace(/^-100/, '');
  return /^\d+$/.test(internal) ? `https://t.me/c/${internal}/${r.telegram_message_id}` : null;
}

// При пустой выдаче даём модели реальные цифры по базе, чтобы она не гадала
async function baseCounts() {
  const count = async (build) => {
    let q = supabase.from('listings').select('id', { count: 'exact', head: true })
      .neq('is_duplicate', true).neq('label_kind', 'agent').neq('flagged_agent', true);
    const { count: n, error } = await build(q);
    return error ? null : n;
  };
  const [sale, saleUsd, rent] = await Promise.all([
    count((q) => q.eq('deal_type', 'sale')),
    count((q) => q.eq('deal_type', 'sale').eq('price_currency', 'USD')),
    count((q) => q.eq('deal_type', 'rent')),
  ]);
  return { sale_total: sale, sale_in_usd: saleUsd, rent_total: rent };
}

/** Бюджет → фильтр сразу по двум валютам: объявления в $ и в сумах (по курсу ЦБ). */
function budgetFilter(a, rate) {
  const hasMin = Number.isFinite(a.priceMin);
  const hasMax = Number.isFinite(a.priceMax);
  if (!hasMin && !hasMax) return null;
  // валюта не указана — угадываем по величине (миллионы → сумы)
  const cur = a.currency || ((hasMax ? a.priceMax : a.priceMin) >= 1_000_000 ? 'UZS' : 'USD');
  if (!rate) return { simple: cur }; // курса нет — только объявления в той же валюте
  const toUsd = (v) => (cur === 'USD' ? v : v / rate);
  const part = (currency, k) => {
    const c = [`price_currency.eq.${currency}`];
    if (hasMin) c.push(`price_value.gte.${Math.round(toUsd(a.priceMin) * k)}`);
    if (hasMax) c.push(`price_value.lte.${Math.round(toUsd(a.priceMax) * k)}`);
    return `and(${c.join(',')})`;
  };
  return { or: `${part('USD', 1)},${part('UZS', rate)}` };
}


/**
 * Сравнение цены за м² с медианой НАШЕЙ базы (market_stats, ~45 дней) считает код, а не модель:
 * так ИИ не может «оценить рынок» там, где данных нет. Возвращает Map(id → {median_usd_m2, sample, vs_median_pct}).
 * vs_median_pct > 0 — дороже медианы, < 0 — дешевле. Если выборка меньше MIN_MARKET_SAMPLE, сравнения нет.
 */
async function marketComparison(rows, usdM2ById) {
  const deals = [...new Set(rows.map((r) => r.deal_type).filter(Boolean))];
  const types = [...new Set(rows.map((r) => r.property_type).filter(Boolean))];
  const out = new Map();
  if (!deals.length || !types.length) return out;
  const { data, error } = await supabase
    .from('market_stats')
    .select('group_key,median_price_per_sqm,sample_size')
    .in('deal_type', deals)
    .in('property_type', types)
    .limit(600);
  if (error || !data) return out;
  const stats = new Map(data.map((r) => [r.group_key, r]));
  for (const r of rows) {
    const usdM2 = usdM2ById.get(r.id);
    if (!usdM2) continue;
    const base = `${r.property_type}|${r.deal_type}|${r.district}`;
    // у объявления известен сегмент → сравниваем только с тем же сегментом; иначе с районом целиком
    const st = r.market_segment ? stats.get(`${base}|${r.market_segment}`) : stats.get(base);
    if (!st || !st.median_price_per_sqm || st.sample_size < MIN_MARKET_SAMPLE) continue;
    out.set(r.id, {
      median_usd_m2: round(Number(st.median_price_per_sqm), 10),
      sample: st.sample_size,
      vs_median_pct: Math.round((usdM2 / Number(st.median_price_per_sqm) - 1) * 100),
    });
  }
  return out;
}

export async function searchListings(a = {}) {
  const fx = await getUsdRate();
  const rate = fx?.rate || null;

  let q = supabase
    .from('listings')
    .select(
      'id,title,price,price_value,price_currency,district,rooms,area,label_kind,url,raw_text,image_url,published_at,created_at,' +
        'deal_type,property_type,price_per_sqm,below_market,below_market_pct,deal_score,market_segment,urgency_phrase,price_drop_count,last_price_change_pct,' +
        'telegram_chat_id,telegram_message_id,telegram_deleted'
    )
    .neq('is_duplicate', true)
    .neq('label_kind', 'agent')
    .neq('flagged_agent', true);

  if (a.deal) q = q.eq('deal_type', a.deal);
  if (a.type) q = q.eq('property_type', a.type);
  if (Array.isArray(a.district) && a.district.length) {
    const d = a.district.filter((x) => DISTRICTS.includes(x));
    if (d.length) q = q.in('district', d);
  }
  if (Array.isArray(a.rooms) && a.rooms.length) {
    const nums = a.rooms.filter((r) => Number.isInteger(r) && r >= 1 && r <= 4);
    if (a.rooms.includes(5) && nums.length) q = q.or(`rooms.in.(${nums.join(',')}),rooms.gte.5`);
    else if (a.rooms.includes(5)) q = q.gte('rooms', 5);
    else if (nums.length) q = q.in('rooms', nums);
  }

  const budget = budgetFilter(a, rate);
  if (budget?.or) q = q.or(budget.or);
  else if (budget?.simple) {
    q = q.eq('price_currency', budget.simple);
    if (Number.isFinite(a.priceMin)) q = q.gte('price_value', a.priceMin);
    if (Number.isFinite(a.priceMax)) q = q.lte('price_value', a.priceMax);
  }

  if (Number.isFinite(a.areaMin)) q = q.gte('area', a.areaMin);
  if (Number.isFinite(a.areaMax)) q = q.lte('area', a.areaMax);
  if (a.segment === 'new_build' || a.segment === 'secondary') q = q.eq('market_segment', a.segment);
  if (a.ownerOnly) q = q.in('label_kind', ['owner', 'unchecked']);
  if (typeof a.text === 'string' && a.text.trim()) {
    const e = a.text.trim().slice(0, 60).replace(/[%_,()]/g, ' ');
    q = q.or(`title.ilike.%${e}%,raw_text.ilike.%${e}%`);
  }
  if (Array.isArray(a.excludeIds) && a.excludeIds.length) {
    // id в базе текстовые (olx_4vwhz): пропускаем только безопасные значения и берём в кавычки
    const ids = a.excludeIds.filter((x) => typeof x === 'string' && /^[\w.-]{1,64}$/.test(x));
    if (ids.length) q = q.not('id', 'in', `(${ids.map((x) => `"${x}"`).join(',')})`);
  }

  if (a.sort === 'price_asc') q = q.order('price_value', { ascending: true, nullsFirst: false });
  else if (a.sort === 'price_desc') q = q.order('price_value', { ascending: false, nullsFirst: false });
  else if (a.sort === 'best_deal') q = q.order('deal_score', { ascending: false, nullsFirst: false });
  else q = q.order('created_at', { ascending: false });

  const { data, error } = await q.limit(MAX_RESULTS);
  if (error) return { error: error.message, items: [] };

  const rateInfo = fx ? { usd_rate: fx.rate, rate_date: fx.date, rate_source: fx.source } : { usd_rate: null };
  if (!data?.length) return { count: 0, items: [], ...rateInfo, base: await baseCounts() };

  const toUsd = (v, cur) => (v == null ? null : cur === 'UZS' ? (rate ? v / rate : null) : v);
  const usdM2ById = new Map(data.map((r) => [r.id, toUsd(r.price_per_sqm, r.price_currency)]));
  const market = await marketComparison(data, usdM2ById);
  const items = data.map((r) => {
    const usd = toUsd(r.price_value, r.price_currency);
    const usdM2 = toUsd(r.price_per_sqm, r.price_currency);
    return strip({
      id: r.id,
      title: clip(r.title, 90),
      price: r.price_value ? `${r.price_value} ${r.price_currency || ''}`.trim() : clip(r.price, 30),
      usd: round(usd, usd > 20000 ? 100 : 1),
      usd_m2: round(usdM2, 10),
      market: market.get(r.id) || null, // нет поля market = сравнить с рынком НЕЛЬЗЯ (мало данных в нашей базе)
      area: r.area,
      rooms: r.rooms,
      district: r.district,
      seller: r.label_kind === 'owner' ? 'собственник' : r.label_kind === 'uncertain' ? 'неясно' : null,
      segment: r.market_segment === 'new_build' ? 'новостройка' : r.market_segment === 'secondary' ? 'вторичка' : null,
      below_market_pct: r.below_market && r.below_market_pct > 0 ? Math.round(r.below_market_pct) : null,
      deal_score: r.deal_score,
      price_drops: r.price_drop_count > 0 ? r.price_drop_count : null,
      last_price_change_pct: r.price_drop_count > 0 && r.last_price_change_pct != null ? Math.round(r.last_price_change_pct) : null,
      urgent: clip(r.urgency_phrase, 40),
      posted: (r.published_at || r.created_at || '').slice(0, 10) || null,
      url: r.url,
      // описание стирается у объявлений старше ~7 дней — тогда ремонт оценить нельзя
      text: clip(r.raw_text, SNIPPET_CHARS),
      image: r.image_url || null,
    });
  });

  // links уходит не модели, а в карточки ответа (_aiChat.js вырезает это поле перед отправкой модели)
  const links = {};
  for (const r of data) links[r.id] = telegramPostLink(r);
  return { count: items.length, items, ...rateInfo, market_compared: items.filter((i) => i.market).length, links };
}

export async function marketStats(a = {}) {
  let q = supabase
    .from('market_stats')
    .select('group_key,district,median_price_per_sqm,sample_size,updated_at')
    .eq('deal_type', a.deal || 'sale')
    .eq('property_type', a.type || 'apartment');
  if (a.district && DISTRICTS.includes(a.district)) q = q.eq('district', a.district);
  const { data, error } = await q.limit(80);
  if (error) return { error: error.message, rows: [] };

  const rows = (data || [])
    .map((r) => {
      const seg = String(r.group_key || '').split('|')[3];
      return strip({
        district: r.district === '__город__' ? 'весь город' : r.district,
        segment: seg === 'new_build' ? 'новостройка' : seg === 'secondary' ? 'вторичка' : null,
        median_usd_per_m2: round(Number(r.median_price_per_sqm), 10),
        sample: r.sample_size,
      });
    })
    .filter((r) => r.median_usd_per_m2)
    .sort((x, y) => String(x.district).localeCompare(String(y.district), 'ru'));
  return { count: rows.length, rows, note: 'медиана за ~45 дней, в USD; sample < 8 — ненадёжно' };
}
