// Поиск по базе для ИИ-чата. Те же фильтры и те же правила, что в listings.js
// (агентства скрыты, дубли скрыты), но результат сжат до минимума токенов:
// ИИ получает только короткие карточки, а не строки таблицы целиком.

import { supabase } from './_supabase.js';
import { DISTRICTS } from '../src/districts.js';

const MAX_RESULTS = 8;
const SNIPPET_CHARS = 350; // кусок описания: по нему ИИ судит о ремонте

export const SEARCH_TOOL = {
  name: 'search_listings',
  description:
    'Ищет объявления в базе. Вызывай столько раз, сколько нужно (например, сначала с запасом по цене, потом уже). ' +
    'Возвращает до 8 объявлений: id, заголовок, цена, район, комнаты, площадь, продавец, ссылка, фрагмент описания.',
  input_schema: {
    type: 'object',
    properties: {
      district: { type: 'array', items: { type: 'string', enum: DISTRICTS }, description: 'Районы (только из списка)' },
      deal: { type: 'string', enum: ['sale', 'rent'] },
      type: { type: 'string', enum: ['apartment', 'house', 'commercial'] },
      rooms: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 5 }, description: '5 означает 5 и больше' },
      priceMin: { type: 'number' },
      priceMax: { type: 'number' },
      currency: { type: 'string', enum: ['USD', 'UZS'], description: 'Обязательна, если задана цена' },
      ownerOnly: { type: 'boolean', description: 'Только от собственника' },
      text: { type: 'string', description: 'Слова для поиска в заголовке/описании: «евроремонт», «ЖК Мирабад»' },
      sort: { type: 'string', enum: ['new', 'price_asc', 'price_desc'] },
      excludeIds: { type: 'array', items: { type: 'integer' }, description: 'Уже показанные объявления — не повторять' },
    },
  },
};

const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);

export async function searchListings(a = {}) {
  let q = supabase
    .from('listings')
    .select('id,title,price,price_value,price_currency,district,rooms,area,seller_type,label_kind,url,raw_text,deal_type,property_type,image_url,created_at')
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
  if (a.currency === 'USD' || a.currency === 'UZS') q = q.eq('price_currency', a.currency);
  if (Number.isFinite(a.priceMin)) q = q.gte('price_value', a.priceMin);
  if (Number.isFinite(a.priceMax)) q = q.lte('price_value', a.priceMax);
  if (a.ownerOnly) q = q.in('label_kind', ['owner', 'unchecked']);
  if (typeof a.text === 'string' && a.text.trim()) {
    const e = a.text.trim().slice(0, 60).replace(/[%_,()]/g, ' ');
    q = q.or(`title.ilike.%${e}%,raw_text.ilike.%${e}%`);
  }
  if (Array.isArray(a.excludeIds) && a.excludeIds.length) {
    q = q.not('id', 'in', `(${a.excludeIds.filter(Number.isInteger).join(',')})`);
  }

  if (a.sort === 'price_asc') q = q.order('price_value', { ascending: true, nullsFirst: false });
  else if (a.sort === 'price_desc') q = q.order('price_value', { ascending: false, nullsFirst: false });
  else q = q.order('created_at', { ascending: false });

  const { data, error } = await q.limit(MAX_RESULTS);
  if (error) return { error: error.message, items: [] };

  const items = (data || []).map((r) => ({
    id: r.id,
    title: clip(r.title, 90),
    price: r.price_value ? `${r.price_value} ${r.price_currency || ''}`.trim() : clip(r.price, 30),
    district: r.district,
    rooms: r.rooms,
    area: r.area,
    seller: r.label_kind === 'owner' ? 'собственник' : r.label_kind === 'uncertain' ? 'неясно' : null,
    url: r.url,
    // описание стирается у объявлений старше ~7 дней — тогда ремонт оценить нельзя
    text: clip(r.raw_text, SNIPPET_CHARS),
    image: r.image_url || null,
  }));
  return { count: items.length, items };
}
