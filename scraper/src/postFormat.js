// Формат "пост как у риэлторских каналов": альбом фото + подпись вида
//
//   🌟
//   #4646 #вторичка #продажа
//   Ориентир: Mirzo-Ulugbek
//
//   Комната:2
//   Этаж:1
//   Этажность:5
//   Площадь:30кв.м
//
//   Цена : 50 500 $
//
//   #2ком
//   ————————————
//   👤 Имя
//   📞 +998 ...
//   🔗 ссылка на объявление
//
// Всё считается из полей, которые у объявления уже есть. Этаж и
// этажность в базе не хранятся — достаём регулярками из заголовка и
// текста объявления (в памяти на момент отправки). Если не нашли —
// строка просто не выводится, ничего не выдумываем.

export const MAX_PHOTOS = 10; // лимит Telegram на один альбом

/**
 * "1/5 этаж", "этаж 1/5", "этаж: 1 из 5", "1 этаж из 5", "1/5 эт.",
 * "1-этаж 5-этажного дома", "1-qavat 5-qavatli" → { floor, floorsTotal }.
 */
export function parseFloors(...texts) {
  const text = texts.filter(Boolean).join(' \n ');
  if (!text) return { floor: null, floorsTotal: null };

  const patterns = [
    // этаж 3/9 | этаж: 3 из 9 | этаж - 3 / 9
    /(?:этаж|qavat|эт\.?)\s*[:\-–]?\s*(\d{1,2})\s*(?:\/|из|dan|-й из)\s*(\d{1,2})/i,
    // 3/9 этаж | 3/9 эт | 3/9 qavat | 3 из 9 этаж
    /(\d{1,2})\s*(?:\/|из|dan)\s*(\d{1,2})\s*(?:-?\s*)?(?:этаж|эт\b|qavat)/i,
    // 3 этаж из 9 | 3-этаж 9-этажного | 3-й этаж в 9-этажном
    /(\d{1,2})\s*-?\s*(?:й\s*)?(?:этаж|qavat)\w*\s*(?:из|в|dan)?\s*(\d{1,2})\s*-?\s*(?:этажн|qavatli)/i,
    /(\d{1,2})\s*-?\s*(?:й\s*)?этаж\w*\s*из\s*(\d{1,2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const floor = Number(m[1]);
    const total = Number(m[2]);
    if (floor >= 1 && total >= 1 && floor <= total && total <= 60) {
      return { floor, floorsTotal: total };
    }
  }

  // Только этаж: "3 этаж", "этаж 3"
  const single =
    text.match(/(?:этаж|qavat)\s*[:\-–]?\s*(\d{1,2})(?!\s*(?:\/|из|dan))/i) ||
    text.match(/(\d{1,2})\s*-?\s*(?:й\s*)?(?:этаж|qavat)(?!н)(?!\w*\s*из)/i);
  // Только этажность: "9-этажный дом", "в 9 этажном"
  const totalOnly = text.match(/(\d{1,2})\s*-?\s*(?:этажн|qavatli)/i);

  const floor = single ? Number(single[1]) : null;
  const floorsTotal = totalOnly ? Number(totalOnly[1]) : null;
  return {
    floor: floor && floor >= 1 && floor <= 60 ? floor : null,
    floorsTotal: floorsTotal && floorsTotal >= 1 && floorsTotal <= 60 ? floorsTotal : null,
  };
}

function toHashtag(word) {
  if (!word) return null;
  const cleaned = String(word).replace(/['".,()]/g, '').replace(/[\s\-]+/g, '');
  return cleaned ? `#${cleaned}` : null;
}

function formatPrice(listing) {
  // Берём структурные значения, если есть: "50 500 $" как в образце.
  if (listing.price_value && listing.price_currency) {
    const num = Math.round(Number(listing.price_value))
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (listing.price_currency === 'USD') return `${num} $`;
    if (listing.price_currency === 'UZS') return `${num} сум`;
    return `${num} ${listing.price_currency}`;
  }
  return listing.price || 'не указана';
}

function formatArea(area) {
  if (!area) return null;
  const n = Number(area);
  if (!Number.isFinite(n)) return null;
  return `${Number.isInteger(n) ? n : String(n).replace('.', ',')}кв.м`;
}

/**
 * Подпись поста. Только обычный текст (без parse_mode) — в ссылках
 * бывают & и _, которые ломают Markdown/HTML-разметку.
 */
export function buildPostCaption(listing) {
  const { floor, floorsTotal } = parseFloors(listing.title, listing.raw_text);

  const segmentTag =
    listing.market_segment === 'new_build'
      ? '#новостройка'
      : listing.market_segment === 'secondary'
        ? '#вторичка'
        : null;
  const dealTag = listing.deal_type === 'sale' ? '#продажа' : listing.deal_type === 'rent' ? '#аренда' : null;
  const typeTag =
    listing.property_type === 'house' ? '#дом' : listing.property_type === 'commercial' ? '#коммерция' : null;

  const headTags = [segmentTag, typeTag, dealTag].filter(Boolean).join(' ');

  const lines = ['🌟'];
  if (headTags) lines.push(headTags);
  if (listing.district) lines.push(`Ориентир: ${listing.district}`);
  lines.push('');

  const roomsLabel = listing.property_type === 'house' ? 'Комнат' : 'Комната';
  if (listing.rooms) lines.push(`${roomsLabel}:${listing.rooms}`);
  if (floor) lines.push(`Этаж:${floor}`);
  if (floorsTotal) lines.push(`Этажность:${floorsTotal}`);
  const area = formatArea(listing.area);
  if (area) lines.push(`Площадь:${area}`);
  // Пустая строка только если есть блок параметров
  if (listing.rooms || floor || floorsTotal || area) lines.push('');

  lines.push(`Цена : ${formatPrice(listing)}`);
  lines.push('');

  const bottomTags = [
    listing.rooms ? toHashtag(`${listing.rooms}ком`) : null,
    listing.district ? toHashtag(listing.district) : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (bottomTags) lines.push(bottomTags);
  lines.push('————————————————');

  if (listing.seller_name) lines.push(`👤 ${listing.seller_name}`);
  if (listing.phone) lines.push(`📞 ${listing.phone}`);
  lines.push(`🔗 ${listing.url}`);

  return lines.join('\n');
}

/**
 * Список фото для альбома: сначала image_urls (если скрапер собрал
 * несколько), затем image_url; без дублей, только http(s), максимум 10.
 */
export function collectPhotos(listing) {
  const list = [];
  const push = (u) => {
    if (typeof u !== 'string') return;
    const url = u.trim();
    if (/^https?:\/\//i.test(url) && !list.includes(url)) list.push(url);
  };
  if (listing.image_url) push(listing.image_url);
  if (Array.isArray(listing.image_urls)) listing.image_urls.forEach(push);
  return list.slice(0, MAX_PHOTOS);
}

/**
 * Достаёт все фото объявления из HTML-страницы (cheerio $): JSON-LD
 * image (строка или массив), og:image, и картинки галереи. Формат
 * вёрстки у каждого сайта свой и может меняться — поэтому это
 * "best effort", а на выходе всегда как минимум og:image (то же, что
 * было раньше).
 */
export function extractImageUrlsFromHtml($, { extraSelectors = [] } = {}) {
  const found = [];
  const add = (u) => {
    if (typeof u !== 'string') return;
    let url = u.trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (/^https?:\/\//i.test(url) && !/\.(svg|gif)(\?|$)/i.test(url) && !found.includes(url)) found.push(url);
  };

  add($('meta[property="og:image"]').attr('content'));

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        const img = node?.image;
        if (Array.isArray(img)) img.forEach((i) => add(typeof i === 'string' ? i : i?.url));
        else if (img) add(typeof img === 'string' ? img : img?.url);
      }
    } catch {
      // битый JSON-LD — не критично
    }
  });

  for (const sel of extraSelectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      add($el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy') || $el.attr('data-original'));
    });
  }

  return found.slice(0, MAX_PHOTOS);
}
