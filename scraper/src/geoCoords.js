// Достаёт координаты объявления из HTML страницы (если площадка их отдаёт).
// Работает осторожно: принимает только точки внутри Ташкента и окрестностей, остальное отбрасывает.
// Если ничего не нашли, возвращает null, и пост получает пин района, как раньше.
//
// ⚠️ Форматы страниц подобраны по типичной разметке (JSON-блок "map": {lat, lon, radius, show_detailed}),
// на реальной странице olx.uz НЕ проверены. Проверка: node src/check-coords.js <ссылка на объявление>

// Ташкент и ближайшие окрестности (с запасом)
const BBOX = { latMin: 41.0, latMax: 41.6, lngMin: 68.9, lngMax: 69.7 };

export function isInTashkent(lat, lng) {
  return lat >= BBOX.latMin && lat <= BBOX.latMax && lng >= BBOX.lngMin && lng <= BBOX.lngMax;
}

const num = (s) => {
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function pick(block, keys) {
  for (const k of keys) {
    const m = block.match(new RegExp(`"${k}"\\s*:\\s*"?(-?\\d+(?:[.,]\\d+)?)"?`));
    if (m) return num(m[1]);
  }
  return null;
}

const keyOf = (c) => `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;

/**
 * Берём точку ТОЛЬКО если на странице она одна: в JSON страницы могут лежать координаты и других
 * объявлений («похожие»), и пин чужой квартиры хуже пина района. Две и более разных точки → null.
 */
function uniqueOrNull(list) {
  const map = new Map(list.map((c) => [keyOf(c), c]));
  return map.size === 1 ? [...map.values()][0] : null;
}

/**
 * @param {string} html
 * @param {{loose?: boolean}} [opts] loose (или env GEO_LOOSE=1) — разрешить запасные шаблоны (lat/lon, ссылки на карты).
 *   По умолчанию выключено, пока формат реальной страницы не проверен скриптом check-coords.js.
 * @returns {{lat:number, lng:number, radius:number|null, detailed:boolean|null, source:string}|null}
 */
export function extractCoordsFromHtml(html, opts = {}) {
  if (!html) return null;
  const text = String(html);
  const loose = opts.loose ?? process.env.GEO_LOOSE === '1';

  // 1) Блок "map": { ... lat ... lon/lng ... radius ... show_detailed ... } — так обычно отдают карту сайты на платформе OLX
  const fromMap = [];
  for (const m of text.matchAll(/"map"\s*:\s*\{[^{}]{0,400}\}/g)) {
    const block = m[0];
    const lat = pick(block, ['lat', 'latitude']);
    const lng = pick(block, ['lon', 'lng', 'longitude']);
    if (lat != null && lng != null && isInTashkent(lat, lng)) {
      const radius = pick(block, ['radius']);
      const det = block.match(/"show_?[dD]etailed"\s*:\s*(true|false)/i);
      fromMap.push({ lat, lng, radius: radius || null, detailed: det ? det[1] === 'true' : null, source: 'map' });
    }
  }
  const one = uniqueOrNull(fromMap);
  if (one || fromMap.length) return one; // нашли блок map: либо одна точка, либо неоднозначно (null), дальше не гадаем

  if (!loose) return null;

  // 2) Запасные шаблоны (только в loose-режиме)
  const loosePts = [];
  for (const m of text.matchAll(/"(?:lat|latitude)"\s*:\s*"?(-?\d{1,2}\.\d{3,})"?\s*,\s*"(?:lon|lng|longitude)"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?/g)) {
    const lat = num(m[1]);
    const lng = num(m[2]);
    if (lat != null && lng != null && isInTashkent(lat, lng)) loosePts.push({ lat, lng, radius: null, detailed: null, source: 'latlon' });
  }
  for (const m of text.matchAll(/[?&]ll=(-?\d{1,3}\.\d{3,})(?:%2C|,)(-?\d{1,2}\.\d{3,})/g)) { // Яндекс: долгота,широта
    const lng = num(m[1]);
    const lat = num(m[2]);
    if (lat != null && lng != null && isInTashkent(lat, lng)) loosePts.push({ lat, lng, radius: null, detailed: null, source: 'll' });
  }
  for (const m of text.matchAll(/(?:@|query=|q=)(-?\d{1,2}\.\d{3,})(?:%2C|,)(-?\d{1,3}\.\d{3,})/g)) { // Google
    const lat = num(m[1]);
    const lng = num(m[2]);
    if (lat != null && lng != null && isInTashkent(lat, lng)) loosePts.push({ lat, lng, radius: null, detailed: null, source: 'url' });
  }
  return uniqueOrNull(loosePts);
}

/** Подпись под пином в Telegram. */
export function coordsCaption(c) {
  if (c.detailed === true) return 'точка из объявления';
  if (c.radius) return `примерно, радиус ~${Math.round(c.radius)} м`;
  return 'по данным объявления';
}
