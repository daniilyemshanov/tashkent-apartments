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
  if (!text) return { floor: null, floorsTotal: null, rooms: null };

  // "2/2/2", "3/5/9" в названии — по-узбекски: комнаты/этаж/этажность
  const triple = text.match(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/);
  if (triple) {
    const [r, f, tot] = [Number(triple[1]), Number(triple[2]), Number(triple[3])];
    if (r >= 1 && r <= 10 && f >= 1 && f <= tot && tot <= 60) return { floor: f, floorsTotal: tot, rooms: r };
  }

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


// ---------- дополнительные факты и описание ----------

const EXCHANGE_RATE = Number(process.env.EXCHANGE_RATE_USD_UZS) || 12700;
const CAPTION_LIMIT = 1024;

// Строки-параметры вида "Этаж: 3" — собираем со страницы объявления
// (cheerio $), только знакомые ключи, чтобы не тащить мусор вёрстки.
const PARAM_KEY_RE =
  /^(этаж|этажность|этажей|количество комнат|комнат|общая площадь|площадь|жилая площадь|площадь кухни|ремонт|состояние|мебел|планировка|санузел|тип дома|тип здания|материал|год постройки|год|отопление|парковка|лифт|балкон|документ|депозит|предоплата|коммунальн|вид из окон|высота потолк|тип сделки|срок аренды|меблирован|бытовая техника|техника|тип жилья|тип строения|комиссионн|в квартире есть|рядом есть|санузел|планировка)/i;

export function extractParamsFromHtml($) {
  const lines = [];
  $('li, p, div, span').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 3) return;
    const text = $el.clone().find('style, script').remove().end().text().replace(/\s+/g, ' ').trim();
    if (text.length < 5 || text.length > 220) return;
    const m = text.match(/^([^:]{2,40}):\s*(\S.{0,190})$/);
    if (!m || !PARAM_KEY_RE.test(m[1].trim())) return;
    const line = `${m[1].trim()}: ${m[2].trim()}`;
    if (!lines.includes(line)) lines.push(line);
  });
  return lines.slice(0, 25).join('\n');
}

/**
 * Параметры из JSON API (Uybor/Joymee) — названия полей у API не
 * подтверждены вживую, поэтому пробуем несколько вариантов и берём
 * только правдоподобные числа.
 */
export function paramsTextFromApiItem(item) {
  if (!item || typeof item !== 'object') return '';
  const num = (...keys) => {
    for (const k of keys) {
      const v = Number(item[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };
  const floor = num('floor', 'floor_number', 'floorNumber');
  const total = num('floors', 'floors_total', 'floorsTotal', 'floor_total', 'floorTotal', 'total_floors', 'building_floors');
  const rooms = num('rooms', 'rooms_count', 'roomsCount', 'room_count');
  const area = num('square', 'area', 'total_area', 'totalArea');
  const out = [];
  if (floor && floor <= 60) out.push(`Этаж: ${floor}`);
  if (total && total <= 60) out.push(`Этажность: ${total}`);
  if (rooms && rooms <= 20) out.push(`Количество комнат: ${rooms}`);
  if (area && area < 2000) out.push(`Общая площадь: ${area} м²`);
  return out.join('\n');
}

function paramValue(text, keyRe) {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*(?:${keyRe})[^:\\n]*:\\s*([^\\n]{1,50})`, 'i'));
  return m ? m[1].trim() : null;
}

/** Этаж/этажность/комнаты/площадь из строк-параметров ("Этаж: 3"). */
export function parseParams(paramsText) {
  if (!paramsText) return {};
  const num = (s) => {
    const m = String(s || '').match(/\d+(?:[.,]\d+)?/);
    return m ? Number(m[0].replace(',', '.')) : null;
  };
  const floor = num(paramValue(paramsText, 'этаж(?!ност|ей)'));
  const floorsTotal = num(paramValue(paramsText, 'этажность|этажей'));
  const rooms = num(paramValue(paramsText, 'количество комнат|комнат'));
  const area = num(paramValue(paramsText, 'общая площадь|площадь(?! кухни)'));
  return {
    floor: floor >= 1 && floor <= 60 ? floor : null,
    floorsTotal: floorsTotal >= 1 && floorsTotal <= 60 ? floorsTotal : null,
    rooms: rooms >= 1 && rooms <= 20 ? rooms : null,
    area: area > 0 && area < 2000 ? area : null,
  };
}

/**
 * Полезные факты из текста: ремонт, мебель, техника, комиссия,
 * депозит, торг, документы и т.п. Только то, что реально найдено.
 */
export function extractFacts(listing) {
  const params = listing.params_text || '';
  const text = `${params}\n${listing.title || ''}\n${listing.raw_text || ''}`;
  const low = text.toLowerCase();
  const facts = [];

  // Состояние
  let condition = paramValue(params, 'ремонт|состояние');
  if (!condition) {
    if (/дизайнерск/.test(low)) condition = 'дизайнерский ремонт';
    else if (/евро\s?ремонт|euro\s?remont|еврорем/.test(low)) condition = 'евроремонт';
    else if (/требует\s+ремонт|без\s+ремонта|нужен\s+ремонт/.test(low)) condition = 'требует ремонта';
    else if (/чернов|коробк|самоотделк|pesh/.test(low)) condition = 'черновая отделка';
    else if (/косметическ/.test(low)) condition = 'косметический ремонт';
    else if (/(?:с|после|свежий|капитальный)\s+ремонт|ремонтом|отремонтирован|jonli remont/.test(low)) condition = 'с ремонтом';
  }
  if (condition) facts.push(`Ремонт: ${condition.toLowerCase()}`);

  // Дом, планировка, санузел — из характеристик карточки
  const building = paramValue(params, 'тип строения|тип дома|материал');
  if (building) facts.push(`Дом: ${building.toLowerCase()}`);
  const layout = paramValue(params, 'планировка');
  if (layout) facts.push(`Планировка: ${layout.toLowerCase()}`);
  const bath = paramValue(params, 'санузел');
  if (bath) facts.push(`Санузел: ${bath.toLowerCase()}`);

  // Мебель
  const furnitureParam = paramValue(params, 'меблирован|мебел');
  if (furnitureParam) {
    facts.push(`Мебель: ${/^(да|есть|yes)/i.test(furnitureParam) ? 'есть' : /^(нет|no)/i.test(furnitureParam) ? 'нет' : furnitureParam.toLowerCase()}`);
  } else if (/без\s+мебел|не\s+меблирован|пустая/.test(low)) facts.push('Мебель: нет');
  else if (/с\s+мебел|меблирован|мебелью|мебель\s+есть|jihozlar|мебель\s+и\s+техник/.test(low)) facts.push('Мебель: есть');

  // Техника
  const appliances = [];
  if (/кондиционер|conditsioner|konditsioner/.test(low)) appliances.push('кондиционер');
  if (/холодильник|xolodilnik/.test(low)) appliances.push('холодильник');
  if (/стиральн|kir yuvish/.test(low)) appliances.push('стиралка');
  if (/телевизор|tv\b/.test(low)) appliances.push('ТВ');
  if (/посудомоечн/.test(low)) appliances.push('посудомойка');
  if (appliances.length) facts.push(`Техника: ${appliances.join(', ')}`);

  // Здание/удобства
  const extras = [];
  if (/лифт/.test(low) && !/без\s+лифт|нет\s+лифт/.test(low)) extras.push('лифт');
  if (/парковк|паркинг|гараж|avtoturargoh/.test(low)) extras.push('парковка');
  if (/балкон|лоджи/.test(low)) extras.push('балкон');
  if (/охран|закрыт(?:ая|ый)\s+(?:территори|двор)/.test(low)) extras.push('охрана');
  if (/детск\w+\s+площадк/.test(low)) extras.push('детская площадка');
  if (extras.length) facts.push(`Есть: ${extras.join(', ')}`);

  const nearby = paramValue(params, 'рядом есть');
  if (nearby) facts.push(`Рядом: ${nearby.length > 70 ? `${nearby.slice(0, 67).replace(/[,\s]+\S*$/, '')}…` : nearby}`);

  // Метро/ориентир из текста
  const metro = text.match(/метро\s+([А-ЯЁA-Z][\wА-Яа-яёЁ'’-]{2,25})|([А-ЯЁA-Z][\wА-Яа-яёЁ'’-]{2,25})\s+метро/);
  const metroName = metro ? (metro[1] || metro[2]) : null;
  if (metroName && !/^(рядом|возле|близко|от|до|у)$/i.test(metroName)) facts.push(`Метро: ${metroName}`);

  // Условия
  const deposit = text.match(/(?:депозит|залог|предоплат\w*)\s*[:\-–]?\s*([^\n.,;]{1,30})/i);
  if (listing.deal_type === 'rent' && deposit) facts.push(`Депозит: ${deposit[1].trim()}`);
  const commissionParam = paramValue(params, 'комиссионн');
  if (commissionParam && /^нет|^no/i.test(commissionParam)) facts.push('Без комиссии');
  else if (/без\s+комисси|безмаклер|без\s+маклер|без\s+посредник|от\s+хозяина|от\s+собственник|egasidan|vositachi\s+bo['’]?lmagan/.test(low)) {
    facts.push('Без комиссии');
  }
  if (/торг\s+уместен|уместен\s+торг|возможен\s+торг|торг(?:\s+есть)?\b(?!\s+не)|kelishamiz/.test(low) && !/без\s+торг|торга\s+нет|торг\s+не/.test(low)) {
    facts.push('Торг возможен');
  }
  if (listing.deal_type === 'sale') {
    const docs = [];
    if (/кадастр|купчая|купчей|kadastr/.test(low)) docs.push('купчая/кадастр');
    if (/ипотек|ipoteka/.test(low)) docs.push('ипотека');
    if (/рассрочк|bo['’]?lib\s+to['’]?lash/.test(low)) docs.push('рассрочка');
    if (docs.length) facts.push(`Документы/оплата: ${docs.join(', ')}`);
  }
  if (/коммунальн\w*\s+(?:включен|входят|оплачивает\s+хозяин)/.test(low)) facts.push('Коммуналка включена');
  if (/семье|для\s+семьи|oilaga/.test(low) && listing.deal_type === 'rent') facts.push('Для семьи');

  return facts;
}

function toUsdApprox(value, currency) {
  if (!value) return null;
  return currency === 'UZS' ? value / EXCHANGE_RATE : currency === 'USD' ? value : null;
}

function spaced(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatPublished(publishedAt) {
  if (!publishedAt) return null;
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

/**
 * Чистит описание с площадки для вставки в пост: убирает название,
 * ссылки, телефоны, хештеги и лишние пробелы/переносы.
 */
export function cleanDescription(listing) {
  let text = String(listing.raw_text || '');
  if (!text) return '';
  const title = String(listing.title || '').trim();
  if (title && text.startsWith(title)) text = text.slice(title.length);
  text = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\.css-[\w-]+\s*\{[^{}]*\}?/g, ' ')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, ' ') // телефоны
    .replace(/#[\p{L}\d_]+/gu, ' ')
    .replace(/^\s*Описание\s*/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Остатки фраз после вырезанного телефона ("Звоните по телефону .")
    .replace(/(?:звоните|звонить|позвоните|тел(?:ефон)?\.?|по\s+телефону|whatsapp|telegram|tel)(?:\s+(?:по\s+телефону|по\s+номеру))?\s*[:\-–]?\s*(?=[.,;!]|$)/gi, ' ')
    .replace(/\s+([.,;!])/g, '$1')
    .replace(/([.,;!])(?:\s*[.,;!])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text;
}

function fitDescription(text, budget) {
  if (!text || budget < 120) return '';
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget - 1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > budget * 0.5) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > budget * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:\-–\s]+$/, '')}…`;
}

/**
 * Подпись поста. Только обычный текст (без parse_mode) — в ссылках
 * бывают & и _, которые ломают Markdown/HTML-разметку.
 */
/** Приводит телефон к виду +998 99 123 45 67 (OLX отдаёт кривые "+99 891 9593377"). */
export function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 9) return phone || null;
  const n = digits.slice(-9);
  return `+998 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7, 9)}`;
}

export function buildPostCaption(listing) {
  const fromText = parseFloors(listing.title, listing.raw_text);
  const fromParams = parseParams(listing.params_text);
  const floor = fromParams.floor ?? fromText.floor;
  const floorsTotal = fromParams.floorsTotal ?? fromText.floorsTotal;
  const rooms = listing.rooms ?? fromParams.rooms ?? fromText.rooms ?? null;
  const areaValue = listing.area ?? fromParams.area;

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
  const paramLines = [];
  if (rooms) paramLines.push(`${roomsLabel}:${rooms}`);
  if (floor) paramLines.push(`Этаж:${floor}`);
  if (floorsTotal) paramLines.push(`Этажность:${floorsTotal}`);
  const area = formatArea(areaValue);
  if (area) paramLines.push(`Площадь:${area}`);
  if (paramLines.length) lines.push(...paramLines, '');

  const facts = extractFacts(listing);
  if (facts.length) lines.push(...facts, '');

  // Цена: в сумах добавляем примерный эквивалент в $, для продажи —
  // цену за м².
  let priceLine = `Цена : ${formatPrice(listing)}`;
  if (listing.price_currency === 'UZS') {
    const usd = toUsdApprox(listing.price_value, 'UZS');
    if (usd) priceLine += ` (≈ ${spaced(usd)} $)`;
  }
  lines.push(priceLine);
  if (listing.deal_type === 'sale' && listing.price_per_sqm && listing.price_currency) {
    const perSqmUsd = toUsdApprox(Number(listing.price_per_sqm), listing.price_currency);
    if (perSqmUsd) lines.push(`≈ ${spaced(perSqmUsd)} $/м²`);
  }
  const published = formatPublished(listing.published_at);
  if (published) lines.push(`Опубликовано: ${published}`);
  lines.push('');

  const bottomTags = [
    rooms ? toHashtag(`${rooms}ком`) : null,
    listing.district ? toHashtag(listing.district) : null,
  ]
    .filter(Boolean)
    .join(' ');
  const tail = [];
  if (bottomTags) tail.push(bottomTags);
  tail.push('————————————————');
  if (listing.seller_name) tail.push(`👤 ${listing.seller_name}`);
  if (listing.phone) tail.push(`📞 ${formatPhone(listing.phone)}`);
  tail.push(`🔗 ${listing.url}`);

  // Описание занимает всё, что осталось в лимите подписи (1024) —
  // ссылка и телефон никогда не обрезаются.
  const fixedLength = [...lines, ...tail].join('\n').length + 2 /* пустая строка */ + 4 /* "📝 " + запас */;
  const description = fitDescription(cleanDescription(listing), CAPTION_LIMIT - fixedLength - 5);
  if (description) lines.push(`📝 ${description}`, '');

  return [...lines, ...tail].join('\n');
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
