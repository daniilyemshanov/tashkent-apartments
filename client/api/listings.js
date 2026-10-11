import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';
import { sortByPriority } from './_priority.js';

// Раньше этот эндпоинт возвращал ВСЕ подходящие объявления одним
// массивом (сначала лимит 1000 от Supabase, потом .range(0,4999),
// потом честную выгрузку без потолка вообще) — и фильтровал/сортировал
// фронтенд уже после того, как всё это прилетело браузеру. При тысячах
// строк это и есть основная причина тормозов: гигантский JSON каждые
// 15 секунд + рендер тысяч карточек в DOM разом.
//
// Теперь: постраничная выдача (page/pageSize), и все фильтры (поиск,
// тип сделки, тип недвижимости, статус продавца, связались/нет)
// применяются В САМОМ запросе к Supabase — база отдаёт уже готовый
// кусок, а не всё подряд.

const PAGE_SIZE_DEFAULT = 30;
const PAGE_SIZE_MAX = 100;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const email = await requireAuth(req, res);
  if (!email) return;

  const daysParam = req.query.days;
  const days = daysParam === 'all' ? null : Number(daysParam) || 3;
  const page = Math.max(0, Number(req.query.page) || 0);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE_DEFAULT));
  const q = (req.query.q || '').trim();

  let query = supabase.from('listings').select('*', { count: 'exact' });

  const sort = req.query.sort; // 'new' (по умолчанию) | 'price_asc' | 'price_desc'
  if (sort === 'price_asc') {
    query = query.order('price_value', { ascending: true, nullsFirst: false });
  } else if (sort === 'price_desc') {
    query = query.order('price_value', { ascending: false, nullsFirst: false });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  if (days !== null) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', cutoff);
  }

  // Агентства снова скрываем полностью, как и раньше. ?showAgents=true — для отладки.
  if (req.query.showAgents !== 'true') {
    query = query.neq('label_kind', 'agent').neq('flagged_agent', true);
  }

  if (q) {
    // ilike требует экранировать % и _ (спецсимволы SQL LIKE), иначе
    // поиск с этими символами в тексте будет вести себя странно
    const escaped = q.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(`title.ilike.%${escaped}%,district.ilike.%${escaped}%,raw_text.ilike.%${escaped}%`);
  }

  if (req.query.deal === 'rent' || req.query.deal === 'sale') {
    query = query.eq('deal_type', req.query.deal);
  }
  if (req.query.type && req.query.type !== 'all') {
    query = query.eq('property_type', req.query.type);
  }
  if (req.query.badge === 'owner') {
    query = query.in('label_kind', ['owner', 'unchecked']);
  } else if (req.query.badge === 'unsure') {
    query = query.eq('label_kind', 'uncertain');
  }
  if (req.query.contacted === 'yes') {
    query = query.eq('contacted', true);
  } else if (req.query.contacted === 'no') {
    query = query.neq('contacted', true);
  }

  // Район — точное совпадение с нормализованным canonical-названием
  // (см. _districts.js). Можно выбрать несколько через запятую.
  if (req.query.district) {
    const districts = req.query.district.split(',').map((d) => d.trim()).filter(Boolean);
    if (districts.length === 1) {
      query = query.eq('district', districts[0]);
    } else if (districts.length > 1) {
      query = query.in('district', districts);
    }
  }

  // Раньше комнатность вообще нельзя было отфильтровать через API
  // сайта (столбец в базе есть, но фильтра не было ни в ручных
  // фильтрах, ни в ИИ-поиске — см. _aiSearch.js) — теперь ИИ-поиск
  // умеет извлекать rooms из текста, и он должен куда-то применяться.
  // По просьбе Владика (24.08.2026): комнатность, как и район, можно
  // выбрать сразу несколько ("2-3 комнаты") — req.query.rooms теперь
  // список через запятую ("2,3" или "2,3,5plus"), а не одно значение.
  if (req.query.rooms) {
    const roomsList = req.query.rooms.split(',').map((r) => r.trim()).filter(Boolean);
    const numeric = roomsList.filter((r) => r !== '5plus').map(Number).filter(Number.isFinite);
    const has5plus = roomsList.includes('5plus');
    if (has5plus && numeric.length) {
      query = query.or(`rooms.in.(${numeric.join(',')}),rooms.gte.5`);
    } else if (has5plus) {
      query = query.gte('rooms', 5);
    } else if (numeric.length) {
      query = query.in('rooms', numeric);
    }
  }

  // Площадь — актуальна для коммерции (офис/склад/магазин меряют
  // метрами, не комнатами). area — обычный числовой столбец, без
  // валют/пересчётов, поэтому фильтруем прямо в SQL, в отличие от
  // цены.
  const areaMin = Number(req.query.areaMin);
  const areaMax = Number(req.query.areaMax);
  if (req.query.areaMin && Number.isFinite(areaMin)) query = query.gte('area', areaMin);
  if (req.query.areaMax && Number.isFinite(areaMax)) query = query.lte('area', areaMax);

  // Цена: price_value — просто число без учёта валюты, поэтому
  // диапазон имеет смысл только вместе с выбранной валютой (иначе
  // сравниваются несопоставимые величины — доллары и суммы).
  if (req.query.currency === 'USD' || req.query.currency === 'UZS') {
    query = query.eq('price_currency', req.query.currency);
  }
  const priceMin = Number(req.query.priceMin);
  const priceMax = Number(req.query.priceMax);
  if (req.query.priceMin && Number.isFinite(priceMin)) query = query.gte('price_value', priceMin);
  if (req.query.priceMax && Number.isFinite(priceMax)) query = query.lte('price_value', priceMax);

  if (req.query.assigned === 'none') {
    query = query.is('assigned_to', null);
  }

  query = query.neq('is_duplicate', true);

  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await query.range(from, to);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const total = count ?? data.length;
  res.status(200).json({
    items: sort === 'price_asc' || sort === 'price_desc' ? data : sortByPriority(data),
    total,
    hasMore: from + data.length < total,
  });
}
