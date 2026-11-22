import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';
import { parsePrice } from '../priceParser.js';
import { detectMarketSegment } from '../marketSegment.js';
import { extractParamsFromHtml, extractImageUrlsFromHtml } from '../postFormat.js';
import { extractCoordsFromHtml } from '../geoCoords.js';

// Два раздела — аренда и продажа квартир по Ташкенту. Забираем ВСЕ
// объявления в каждом, не только помеченные сайтом "от собственника"
// (часть реальных собственников просто не ставят эту галочку).
// Фильтрацию собственник/агент делает классификация в classify.js.
// Три категории недвижимости — у каждой свой URL-паттерн (проверено
// вживую на olx.uz). property_type пишем в объявление, чтобы отличать
// их на сайте/в боте фильтром.
export const OLX_CATEGORIES = {
  apartment: {
    rent: 'https://www.olx.uz/nedvizhimost/kvartiry/arenda-dolgosrochnaya/tashkent/',
    sale: 'https://www.olx.uz/nedvizhimost/kvartiry/prodazha/tashkent/',
  },
  house: {
    rent: 'https://www.olx.uz/nedvizhimost/doma/arenda-dolgosrochnaya/tashkent/',
    sale: 'https://www.olx.uz/nedvizhimost/doma/prodazha/tashkent/',
  },
  commercial: {
    // у коммерции на OLX аренда называется просто "arenda", без "-dolgosrochnaya"
    rent: 'https://www.olx.uz/nedvizhimost/kommercheskie-pomeshcheniya/arenda/tashkent/',
    sale: 'https://www.olx.uz/nedvizhimost/kommercheskie-pomeshcheniya/prodazha/tashkent/',
  },
};

// Оставлено для обратной совместимости (старые импорты в run.js/тестах).
export const OLX_URLS = OLX_CATEGORIES.apartment;

const LISTING_LINK_RE = /\/d\/obyavlenie\/[^"'\s]*-ID([a-zA-Z0-9]+)\.html/;
// Раньше было [\d\s]{3,} — "любой набор цифр и пробелов от 3 символов"
// перед "сум"/"у.е.". Проблема: это могло случайно склеить цену с
// соседним числом без разделителя-не-цифры (например, "3/9 4 596 985
// сум" — этаж "3/9" отделён слэшем, но следующая цифра "9" после
// пробела уже воспринималась как начало цены, и вместо "4 596 985"
// получалось "9 4 596 985" → лишняя цифра спереди, цена в 10 раз
// больше реальной). Теперь требуем ПРАВИЛЬНОЕ разбиение по разрядам
// (группы ровно по 3 цифры через пробел, как OLX и форматирует суммы:
// "4 596 985") — так число "9 4 596 985" не пройдёт как одна цена,
// потому что "9 4" — не валидная группа разрядов.
const PRICE_RE = /\d{1,3}(?:[\s\u00A0]\d{3})*\s*(?:сум|у\.?\s?е\.?)/i;

// Второй уровень защиты от кривой цены (после ужесточения самого
// PRICE_RE выше) — грубая проверка "разумных границ" рынка Ташкента.
// Если распарсенное число вообще не лезет ни в какие ворота для этого
// типа сделки — лучше не показывать цену, чем показать в 10 раз
// завышенную/заниженную из-за случайно захваченной соседней цифры.
// Границы намеренно широкие (с запасом), чтобы не резать реальные
// дорогие/дешёвые варианты — это просто "не бывает такого" фильтр.
const PLAUSIBLE_RANGES = {
  rent: { UZS: [200000, 150000000], USD: [20, 15000] },
  sale: { UZS: [30000000, 200000000000], USD: [2000, 15000000] },
};

export function isPlausiblePrice(rawPrice, dealType) {
  if (!rawPrice) return true; // пустую цену не трогаем — это отдельный случай
  const { value, currency } = parsePrice(rawPrice);
  if (value === null || !currency) return true; // не смогли распарсить — не блокируем
  const ranges = PLAUSIBLE_RANGES[dealType] || PLAUSIBLE_RANGES.rent;
  const range = ranges[currency];
  if (!range) return true;
  return value >= range[0] && value <= range[1];
}

// OLX подписывает карточки датой публикации: "Сегодня в 14:23", "Вчера в 09:10"
// или конкретной датой ("30 июля"). Берём "сегодня" И "вчера" (см. RECENT_RE
// ниже) — двухдневное окно вместо одного дня, решение от 12.08.2026:
// так меньше риск пропустить объявление, если прогон скрапера (раз в
// 15 минут) на какое-то время прервался/опоздал — см. комментарий про
// внешний cron-сервис в scrape.yml. Более старые объявления (не
// сегодня/вчера) по-прежнему отбрасываем — иначе в базу лезут старые
// объявления, поднятые в топ платным продвижением.
const RECENT_RE = /сегодня|вчера/i;
const DATE_META_RE = /(сегодня|вчера)\s*(?:в\s*\d{1,2}:\d{2})?|(\d{1,2}\s?(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*)/i;

/**
 * @param {'rent'|'sale'} dealType
 * @param {'apartment'|'house'|'commercial'} propertyType
 */
// Общие заголовки для всех запросов к olx.uz — раньше в разных местах
// файла были разные (местами совсем куцые, например голый
// 'Mozilla/5.0' без остального на странице объявления), что могло
// увеличивать шанс попасть под анти-бот эвристику. Теперь одинаковые
// везде и максимально похожи на настоящий Chrome.
const OLX_BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.olx.uz/',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
};

export async function fetchOlxListings(dealType = 'rent', propertyType = 'apartment') {
  const url = OLX_CATEGORIES[propertyType][dealType];
  const { data: html } = await getWithRetry(
    url,
    {
      headers: OLX_BROWSER_HEADERS,
      timeout: 15000,
    },
    3,
    true // useProxy — см. http.js: список объявлений это то, что бьётся 403 всю ночь
  );

  const $ = cheerio.load(html);
  const seen = new Map(); // externalId -> listing, чтобы не дублировать
  let skippedOld = 0;

  // Ищем ВСЕ ссылки на страницы объявлений (шаблон /d/obyavlenie/...-IDxxxx.html) —
  // это устойчивее к смене CSS-классов, чем привязка к конкретному
  // data-атрибуту вроде data-cy="l-card".
  $('a[href*="/d/obyavlenie/"]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href') || '';
    const idMatch = href.match(LISTING_LINK_RE);
    if (!idMatch) return;

    const externalId = idMatch[1];
    if (seen.has(externalId)) return; // уже нашли эту карточку через другую ссылку (картинка/заголовок)

    const fullUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;

    // Заголовок — берём текст самой ссылки; если пусто (ссылка на картинку) —
    // пробуем alt у картинки внутри неё. Сначала убираем <style>/<script>,
    // которые OLX иногда вставляет прямо внутрь карточки (scoped-стили) —
    // без этого .text() захватывал бы CSS-код вместо реального заголовка.
    const linkClone = link.clone();
    linkClone.find('style, script').remove();
    let title = linkClone.text().trim();
    if (!title) {
      title = link.find('img').attr('alt')?.trim() || '';
    }
    if (!title || title.startsWith('.css-')) return; // мусор вместо заголовка — пропускаем

    // Цену и дату публикации ищем в ближайшем родительском блоке-карточке.
    // ВАЖНО: раньше здесь поднимались вверх на 5 уровней БЕЗ проверки, не
    // вышли ли мы уже за пределы карточки этого объявления — на сеточной
    // вёрстке OLX 3-4 уровня вверх обычно попадают в общий контейнер сразу
    // нескольких карточек, и regex цены мог выхватить цену СОСЕДНЕГО
    // объявления. Из-за этого у многих объявлений цена была неправильной.
    // Теперь останавливаемся, как только в контейнере находится больше
    // одного РАЗНЫХ объявления (считаем по уникальным ID из ссылок, а не
    // по числу тегов <a> — у карточки обычно 2 ссылки на один и тот же
    // объект: картинка + заголовок).
    let price = '';
    let dateRaw = '';
    let container = link.parent();
    for (let i = 0; i < 6 && container.length; i++) {
      const idsInside = new Set();
      container.find('a[href*="/d/obyavlenie/"]').each((_, a) => {
        const m = ($(a).attr('href') || '').match(LISTING_LINK_RE);
        if (m) idsInside.add(m[1]);
      });
      if (idsInside.size > 1) break; // вышли за пределы карточки — не читаем дальше

      const text = container.text();
      if (!price) {
        const priceMatch = text.match(PRICE_RE);
        if (priceMatch && isPlausiblePrice(priceMatch[0], dealType)) {
          price = priceMatch[0].trim();
        }
        // если цена нашлась, но выглядит неправдоподобно — НЕ берём её и
        // НЕ помечаем price как найденную, идём выше по DOM ещё на
        // уровень в надежде найти корректную; если так и не найдём —
        // просто останется пустой (см. posted_raw ниже, аналогично)
      }
      if (!dateRaw) {
        const dateMatch = text.match(DATE_META_RE);
        if (dateMatch) dateRaw = dateMatch[0].trim();
      }
      if (price && dateRaw) break;
      container = container.parent();
    }

    // Если дату не нашли вообще — не рискуем отбрасывать объявление
    // (лучше показать лишнее, чем упустить), помечаем как "неизвестно".
    // Если дата есть и это НЕ "сегодня"/"вчера" — пропускаем, это старый пост.
    const isRecent = !dateRaw || RECENT_RE.test(dateRaw);
    if (!isRecent) {
      skippedOld++;
      return;
    }

    seen.set(externalId, {
      id: `olx_${externalId}`,
      source: 'olx',
      deal_type: dealType, // 'rent' | 'sale'
      property_type: propertyType, // 'apartment' | 'house' | 'commercial'
      url: fullUrl,
      title,
      price,
      posted_raw: dateRaw || 'неизвестно',
    });
  });

  if (skippedOld > 0) {
    console.log(`[olx-${dealType}] пропущено ${skippedOld} старых объявлений (не "сегодня"/"вчера")`);
  }

  return Array.from(seen.values());
}

/**
 * Заходит на страницу конкретного объявления и вытаскивает:
 * - полный текст описания (для классификации собственник/агент)
 * - имя продавца (ещё один сигнал для классификации)
 * - ссылку "Все объявления автора" (чтобы посчитать, сколько у него
 *   объявлений — если много, это почти наверняка агентство)
 */
/**
 * OLX кладёт на КАЖДУЮ страницу объявления структурированный блок
 * <script type="application/ld+json"> (schema.org/Product) — для
 * поисковиков, но нам он тоже полезен: там надёжно, без хрупкого
 * парсинга вёрстки, лежат sku (числовой ID — нужен для запроса
 * телефона, см. fetchOlxPhone), цена+валюта и район (areaServed.name).
 * Подтверждено вживую 06.08.2026 (реальный HTML конкретного
 * объявления), формат:
 *   { "sku": "65297366",
 *     "offers": { "price": 8, "priceCurrency": "USD" },
 *     "offers": { "areaServed": { "name": "Юнусабадский район" } } }
 */
function parseJsonLd($) {
  let result = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (result) return;
    try {
      const json = JSON.parse($(el).contents().text());
      if (json && json['@type'] === 'Product') result = json;
    } catch {
      // не JSON-LD или битый — пропускаем, это не критично, есть fallback'и
    }
  });
  return result;
}

export async function fetchOlxDetails(url, { skipPhone = false } = {}) {
  const { data: html } = await getWithRetry(
    url,
    {
      headers: OLX_BROWSER_HEADERS,
      timeout: 15000,
    },
    3,
    true // useProxy
  );
  const $ = cheerio.load(html);
  // Как и с заголовком в fetchOlxListings — OLX иногда вставляет scoped
  // <style> прямо внутрь блока описания, и без удаления этих тегов
  // .text() затягивает CSS-код (например ".css-1f8vyal{...}") прямо в
  // текст описания, который потом уходит в базу и показывается на
  // сайте (см. баг с мусорным CSS в карточках объявлений).
  const descriptionEl = $('[data-cy="ad_description"]').clone();
  descriptionEl.find('style, script').remove();
  let description = descriptionEl.text().trim();
  // Внутри ad_description на странице OLX есть свой заголовок-лейбл
  // "Описание" (<h2>/<div> перед самим текстом объявления) — .text()
  // склеивает его с текстом объявления без пробела/переноса строки,
  // получается "ОписаниеOlmazor tumani..." прямо в начале. Срезаем
  // этот лейбл, если он оказался приклеен к началу.
  description = description.replace(/^Описание\s*/i, '');
  // Страховка на случай, если <style> окажется ВНЕ поддерева
  // ad_description (например, вынесен в соседний узел вёрсткой) —
  // тогда .find() выше его не увидит и текст CSS-правила всё равно
  // просочится. Дополнительно вырезаем сам паттерн CSS-правила
  // (".css-xxxxx{...}") прямо из итогового текста.
  description = description
    .replace(/\.css-[\w-]+\s*\{[^{}]*\}?/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  const imageUrls = extractImageUrlsFromHtml($, { extraSelectors: ['[data-testid="ad-photo"] img', '.swiper-zoom-container img'] });

  const jsonLd = parseJsonLd($);
  const offerId = jsonLd?.sku || null;

  // Телефон — через подтверждённый вживую эндпоинт (см. fetchOlxPhone).
  // Работает только если нашли числовой ID в JSON-LD; если нет — просто
  // не будет номера с этого источника, останется fallback на текст
  // описания (см. PHONE_REGEX в run.js).
  let phone = null;
  if (offerId && !skipPhone) {
    phone = await fetchOlxPhone(offerId);
  }

  // Цена и район из JSON-LD — надёжнее регулярок по вёрстке, но не
  // всегда достоверны (например, у коммерции offers.price иногда
  // указан "за м²", а не общей суммой) — поэтому это ДОПОЛНИТЕЛЬНЫЙ
  // источник, itog price всё ещё проходит через isPlausiblePrice в
  // fetchOlxListings, откуда берётся основная цена. Здесь просто
  // возвращаем как альтернативу, run.js решает, что использовать.
  let ldPrice = null;
  if (jsonLd?.offers?.price && jsonLd?.offers?.priceCurrency) {
    const currencyLabel = jsonLd.offers.priceCurrency === 'USD' ? 'у.е.' : 'сум';
    ldPrice = `${jsonLd.offers.price} ${currencyLabel}`;
  }
  const ldDistrict = jsonLd?.offers?.areaServed?.name || jsonLd?.areaServed?.name || null;

  // Район — ПОДТВЕРЖДЕНО ВЖИВУЮ (реальный кусок JSON со страницы,
  // прислан пользователем): "location":{"cityName":"Ташкент",
  // "districtName":"Сергелийский район","districtId":19,...}.
  // Это основной, надёжный источник — обычное значение JSON-поля,
  // не завязано на конкретную вёрстку/CSS-класс. ⚠️ Раньше этот блок
  // был случайно вытеснен попыткой брать район из jsonLd.offers.
  // areaServed (schema.org-поле, НЕ подтверждено вживую — скорее
  // всего это просто город для SEO, не гранулярный район) — из-за
  // этого объявления без района прямо в тексте описания переставали
  // получать район вообще. Возвращаем как основной источник, JSON-LD
  // and текстовый fallback — только как запасные варианты.
  const districtNameMatch = html.match(/"districtName"\s*:\s*"([^"]+)"/);
  const rawDistrictName = districtNameMatch ? districtNameMatch[1].trim() : null;

  // Блок "МЕСТОПОЛОЖЕНИЕ" на странице объявления — самый слабый
  // fallback, на случай если оба JSON-источника выше не сработали
  // (ищем по тексту всей страницы, точный CSS-класс блока не
  // подтверждён вживую).
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const locationMatch = bodyText.match(/Ташкент\s*,\s*([А-ЯЁ][а-яё-]+\s+район)/i);
  const locationDistrict = rawDistrictName || ldDistrict || (locationMatch ? locationMatch[1].trim() : null);

  // Карточка "ПОЛЬЗОВАТЕЛЬ" (сайдбар) — ПОДТВЕРЖДЕНО ВЖИВУЮ 09.08.2026,
  // реальный пример (агент открыто назвал себя риэлтором):
  //   <div data-testid="aside" class="...">
  //     <a href="https://realtorshovkat.olx.uz/home/" class="...">
  //       <img alt="Shovkat Real Estate Agent" ...>
  //       Realtor Shovkat
  //       на OLX с июль 2023 г.
  //       Все объявления автора →
  //     </a>
  //   </div>
  // В отличие от карусели "Все объявления автора" ниже (которая
  // показывается, только если у продавца ЕСТЬ другие объявления), эта
  // карточка есть на КАЖДОЙ странице объявления — то есть надёжнее как
  // источник ссылки на профиль в принципе.
  //
  // Плюс отсюда же берём МГНОВЕННЫЙ бесплатный сигнал агентства: если
  // имя продавца или подпись у аватарки прямым текстом говорит
  // "риэлтор"/"realtor"/"real estate agent"/"агентство" и т.п. — это
  // безусловный признак агента, даже без похода на страницу профиля и
  // подсчёта объявлений (у которого посчитанное число может быть и
  // маленьким, если агент только начал работать на OLX).
  const asideCard = $('[data-testid="aside"]');
  let sellerCardName = '';
  let sellerAvatarAlt = '';
  let sellerListingsUrl = null; // ⚠️ была случайно потеряна при одной из правок — из-за
  // этого fetchOlxDetails падал с ReferenceError на КАЖДОМ объявлении
  // (строгий режим ES-модулей не прощает присваивание необъявленной
  // переменной), и весь блок детекции агента вообще не выполнялся.
  if (asideCard.length) {
    const asideLink = asideCard.find('a[href*=".olx.uz/"]').first();
    const asideHref = asideLink.attr('href');
    if (asideHref) {
      sellerListingsUrl = asideHref.startsWith('http') ? asideHref : `https://www.olx.uz${asideHref}`;
    }
    sellerAvatarAlt = asideCard.find('img').attr('alt') || '';
    sellerCardName = asideLink.text().trim();
  }
  const AGENT_NAME_HINT_RE =
    /риэлтор|риелтор|realtor|\brealty\b|real\s*estate|недвижимост|агентств|\bagency\b|\bagent\b/i;
  const sellerNameLooksLikeAgent = AGENT_NAME_HINT_RE.test(`${sellerCardName} ${sellerAvatarAlt}`);

  // Ссылка на профиль продавца — запасной путь (карусель "Все
  // объявления автора"), если карточка "ПОЛЬЗОВАТЕЛЬ" выше почему-то не
  // нашлась. ПОДТВЕРЖДЕНО ВЖИВУЮ 08.08.2026 через DevTools на реальной
  // странице:
  //   <section class="..." data-cy="seller-other-ads">
  //     <div class="... flex">
  //       <h3 ...>Все объявления автора</h3>
  //       <a href="https://alpharealty0016.olx.uz/home/">Смотреть все</a>
  //     </div>
  //     ...карусель объявлений продавца...
  //   </section>
  // Два важных вывода из этого:
  //  1) data-cy="seller-other-ads" — стабильный тестовый атрибут,
  //     гораздо надёжнее текста кнопки или структуры вёрстки (текст
  //     кнопки OLX уже дважды менял).
  //  2) Ссылка НЕ вида olx.uz/o/{id} (как предполагалось раньше и чего
  //     на OLX Узбекистана просто нет) — это ПОДДОМЕН самого продавца
  //     ({slug}.olx.uz/home/). Старый тир-1 (`a[href^="/o/"]`) поэтому
  //     никогда не срабатывал и всё падало в слабый fallback
  //     (authorAdsCountHint, который может путать категории и требует
  //     вдвое больший порог) — это и было основной причиной, почему
  //     агенты стабильно проскакивали.
  let authorLinkEl = null;

  const sellerSection = $('[data-cy="seller-other-ads"]');
  if (!sellerListingsUrl && sellerSection.length) {
    const link = sellerSection.find('a[href]').first();
    const href = link.attr('href');
    if (href) {
      sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
      authorLinkEl = link.get(0);
    }
  }

  // Запасные варианты — вдруг OLX когда-нибудь уберёт data-cy. Ни один
  // из них не подтверждён вживую (в отличие от варианта выше), включая
  // старый a[href^="/o/"] — оставлен просто на случай, что на каких-то
  // объявлениях всё же встретится такой путь.
  if (!sellerListingsUrl) {
    $('a[href^="/o/"], a[href*="olx.uz/o/"]').each((_, el) => {
      if (sellerListingsUrl) return;
      const href = $(el).attr('href');
      if (href) {
        sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
        authorLinkEl = el;
      }
    });
  }

  const AUTHOR_LINK_TEXT_RE = /все\s+объявлени|объявлени[яй]\s+(?:автора|продавца)|профиль\s+продавца/i;
  if (!sellerListingsUrl) {
    $('a').each((_, el) => {
      if (sellerListingsUrl) return;
      const text = $(el).text().trim().toLowerCase();
      if (AUTHOR_LINK_TEXT_RE.test(text)) {
        const href = $(el).attr('href');
        if (href) {
          sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
          authorLinkEl = el;
        }
      }
    });
  }

  if (!sellerListingsUrl) {
    // Заголовок "Все объявления автора" — на случай, если data-cy
    // пропадёт, но структура "заголовок + соседняя ссылка" останется.
    const heading = $('*')
      .filter((_, el) => {
        const own = $(el).clone().children().remove().end().text().trim().toLowerCase();
        return own === 'все объявления автора';
      })
      .first();
    if (heading.length) {
      const container = heading.closest('section, div').length ? heading.closest('section, div') : heading.parent();
      const link = container.find('a').filter((_, el) => /смотреть\s*все/i.test($(el).text())).first();
      const href = link.attr('href');
      if (href) {
        sellerListingsUrl = href.startsWith('http') ? href : `https://www.olx.uz${href}`;
        authorLinkEl = link.get(0);
      }
    }
  }

  // Доп. сигнал: OLX иногда пишет число объявлений автора прямо в
  // тексте рядом с кнопкой, например "Все объявления автора (34)".
  // Если удалось выцепить это число — сохраняем как подстраховку на
  // случай, если сама страница профиля не откроется/не распарсится
  // (fetchOlxSellerListingsCount вернёт null) — тогда в run.js можно
  // использовать этот hint вместо того, чтобы просто сдаваться.
  // ВНИМАНИЕ: в отличие от fetchOlxSellerListingsCount, это число
  // может включать объявления НЕ из недвижимости (та же причина бага,
  // из-за которого раньше все считались агентами) — поэтому в run.js
  // это используется только как fallback, не как основной сигнал.
  let authorAdsCountHint = null;
  if (authorLinkEl) {
    const nearbyText = $(authorLinkEl).text() + ' ' + $(authorLinkEl).parent().text();
    const countMatch = nearbyText.match(/\((\d+)\)|(\d+)\s*объявлен/i);
    const num = countMatch ? Number(countMatch[1] || countMatch[2]) : null;
    if (Number.isFinite(num)) authorAdsCountHint = num;
  }

  // Имя продавца — сначала пробуем то, что уже нашли в карточке
  // "ПОЛЬЗОВАТЕЛЬ" выше (sellerCardName), это самый надёжный источник.
  let sellerName =
    sellerCardName ||
    $('[data-cy="seller_name"]').text().trim() ||
    $('[data-testid="seller-name"]').text().trim() ||
    '';
  if (!sellerName && authorLinkEl) {
    // запасной вариант: заголовок рядом с найденной ссылкой на профиль
    sellerName = $(authorLinkEl).closest('div').find('h4, h3, [class*="name"]').first().text().trim();
  }

  // "Тип жилья: Вторичный рынок" / "Новостройка" — стандартная строка
  // характеристик карточки OLX (см. marketSegment.js). Ищем по всему
  // bodyText, а не по конкретному CSS-селектору — эта фраза уже точный
  // якорь сама по себе, риск ложного совпадения в другом месте страницы
  // минимален, а привязка к вёрстке (как показал опыт с "Все объявления
  // автора" выше) — самое хрупкое место.
  // Только явная строка "Тип жилья: ..." или текст самого объявления:
  // по всему bodyText слово "Новостройка" ловится из меню/фильтров и
  // ложно помечает вторичку как новостройку.
  const explicitSegment = bodyText.match(/Тип\s+жилья\s*:\s*(новостройк|вторичн)/i);
  const marketSegment = explicitSegment
    ? (/^новостр/i.test(explicitSegment[1]) ? 'new_build' : 'secondary')
    : detectMarketSegment(`${$('h1').first().text()}\n${description}`);

  // Цена в ТОЙ валюте, в которой её видит покупатель на странице
  // ("46 000 у.е."): JSON-LD у OLX может отдавать пересчёт в сумы,
  // из-за чего у объявления в $ получалась цена в миллионах сум.
  let pagePrice = null;
  const priceEl = $('[data-testid="ad-price-container"]').first().text().replace(/\s+/g, ' ').trim();
  const priceSource = priceEl || (bodyText.match(/Опубликовано.{0,80}?\d{1,2}:\d{2}(.{0,300})/)?.[1] || '');
  const priceMatch = priceSource.match(/(\d[\d\s]{2,18}\d)\s*(у\.\s?е\.?|y\.\s?e\.?|сум|\$)/i);
  if (priceMatch) pagePrice = `${priceMatch[1].replace(/\s+/g, ' ').trim()} ${priceMatch[2]}`;

  if (!sellerName) {
    const sn = bodyText.match(/ПОЛЬЗОВАТЕЛЬ\s+(.{2,40}?)\s+на\s+OLX\s+с/i);
    if (sn) sellerName = sn[1].trim();
  }

  return {
    description,
    sellerName: sellerName || null,
    sellerListingsUrl,
    sellerNameLooksLikeAgent,
    authorAdsCountHint,
    locationDistrict,
    phone,
    ldPrice,
    imageUrl,
    imageUrls,
    paramsText: extractParamsFromHtml($),
    pagePrice,
    marketSegment,
    coords: extractCoordsFromHtml(html), // точка на карте со страницы (если есть); только для поста, в базу не пишется
  };
}

/**
 * Считает, сколько ВСЕГО объявлений у продавца на его странице
 * "Все объявления автора" — в любой категории OLX, не только
 * недвижимость. Если их заметно больше одного-двух — это почти
 * наверняка агентство/риелтор, даже если сам текст объявления
 * звучит по-человечески.
 *
 * ВАЖНО (сознательный компромисс, а не забытый баг): раньше здесь был
 * фильтр по слагу ссылки (REAL_ESTATE_SLUG_RE), чтобы не считать
 * "трусы"/телефон/диван и т.п., которые обычный человек может заодно
 * продавать. Но из-за этого агентства, чьи объявления на OLX попадают
 * под нестандартные слаги (не совпадающие с регуляркой), недосчитывались
 * и проходили как "не агент" — то есть агентский спам снова начинал
 * просачиваться в уведомления. По явному решению — считаем ВСЕ
 * объявления продавца без разбора категории: пропустить агентство хуже,
 * чем изредка ошибочно пометить активного частника, который параллельно
 * продаёт что-то ещё.
 *
 * Возвращает null при ошибке (тогда просто не применяем это правило).
 */
export async function fetchOlxSellerListingsCount(sellerListingsUrl) {
  if (!sellerListingsUrl) return null;
  try {
    const { data: html } = await getWithRetry(
      sellerListingsUrl,
      { headers: OLX_BROWSER_HEADERS, timeout: 15000 },
      2,
      true // useProxy
    );
    const $ = cheerio.load(html);

    // ПОДТВЕРЖДЕНО ВЖИВУЮ 08.08.2026: на странице продавца прямым
    // текстом написано "Мы нашли N объявления" (пример — реальное
    // агентство с 453 объявлениями). Это ТОЧНОЕ полное число — в
    // отличие от подсчёта ссылок-карточек ниже, которое видит только
    // первую подгруженную страницу (обычно 20-40 карточек). Из-за
    // этого раньше крупные агентства СИЛЬНО недосчитывались (видели
    // 20-40 вместо реальных сотен) и могли не превышать порог
    // SELLER_LISTINGS_AGENT_THRESHOLD — одна из основных причин, почему
    // агенты проскакивали как "не агент".
    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const foundMatch = bodyText.match(/Мы нашли\s+([\d\s]+?)\s*объявлени/i);
    if (foundMatch) {
      const num = Number(foundMatch[1].replace(/\s/g, ''));
      if (Number.isFinite(num)) return num;
    }

    // Fallback — если формулировку "Мы нашли..." когда-нибудь уберут
    // или переведут иначе: считаем видимые на странице карточки, как
    // было раньше. Это ЗАНИЖЕННАЯ оценка для крупных агентств, но
    // лучше, чем совсем ничего.
    const ids = new Set();
    $('a[href*="/d/obyavlenie/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(LISTING_LINK_RE);
      if (m) ids.add(m[1]);
    });
    return ids.size;
  } catch (err) {
    console.warn(`Не удалось посчитать объявления продавца (${sellerListingsUrl}):`, err.message);
    return null;
  }
}

/**
 * Номер телефона на OLX скрыт за кнопкой "показать номер" и
 * подгружается отдельным запросом к их внутреннему API. Эндпоинт и
 * формат ответа ПОДТВЕРЖДЕНЫ ВЖИВУЮ 06.08.2026 (через DevTools →
 * Network на реальном объявлении):
 *   GET https://www.olx.uz/api/v1/offers/{offerId}/limited-phones/
 *   → { "data": { "phones": ["+99 893 1804767"] } }
 * offerId — это ЧИСЛОВОЙ ID (не то же самое, что буквенно-цифровой код
 * из URL объявления вроде "ID4pYww") — берём его из sku в JSON-LD
 * блока на странице объявления, см. parseJsonLd/fetchOlxDetails выше.
 */

// Circuit breaker: инцидент 19.08.2026 — эндпоинт limited-phones начал
// отдавать 400 буквально на КАЖДОМ объявлении (не единичный сбой, а
// похоже на изменение самого API/защиты на стороне OLX). getWithRetry
// не считает 400 "блокировкой" (короткая пауза ~2-4с вместо 15-30с),
// но при отсутствии верхнего предела попыток это всё равно ~130
// объявлений × 2 попытки за прогон — и прогон не укладывался в
// timeout-minutes джобы (см. .github/workflows/scrape.yml), из-за
// чего GitHub Actions обрывал его на середине.
// Если подряд не удаётся получить телефон для нескольких объявлений —
// почти наверняка сбой на стороне эндпоинта для ВСЕГО прогона, а не
// разовая случайность на конкретном объявлении. В этом случае дальше
// даже не пытаемся — просто возвращаем null сразу, без похода в сеть.
// Состояние живёт только в рамках памяти процесса — каждый новый
// прогон scraper'а (новый процесс Node) начинает со свежим счётчиком,
// так что как только OLX починит эндпоинт, следующий прогон снова
// начнёт получать номера как обычно.
const PHONE_CIRCUIT_BREAKER_THRESHOLD = 5;
let consecutivePhoneFailures = 0;
let phoneCircuitTripped = false;

export async function fetchOlxPhone(offerId) {
  if (phoneCircuitTripped) return null;
  try {
    const { data } = await getWithRetry(
      `https://www.olx.uz/api/v1/offers/${offerId}/limited-phones/`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
        timeout: 10000,
      },
      2,
      true // useProxy
    );
    consecutivePhoneFailures = 0;
    return data?.data?.phones?.[0] || null;
  } catch (err) {
    console.warn(`Не удалось получить телефон (offerId=${offerId}):`, err.message);
    consecutivePhoneFailures++;
    if (consecutivePhoneFailures >= PHONE_CIRCUIT_BREAKER_THRESHOLD) {
      phoneCircuitTripped = true;
      console.warn(
        `[olx-phone] ${consecutivePhoneFailures} телефонов подряд не удалось получить — похоже, эндпоинт limited-phones сломан/блокирует весь этот прогон. Останавливаю попытки получить телефон до конца прогона (остальные объявления обработаются без номера; дедупликация по телефону просто не сработает для них в этом прогоне).`
      );
    }
    return null;
  }
}

/** Только для тестов — сбрасывает состояние circuit breaker'а телефонов. */
export function _resetPhoneCircuitBreakerForTests() {
  consecutivePhoneFailures = 0;
  phoneCircuitTripped = false;
}