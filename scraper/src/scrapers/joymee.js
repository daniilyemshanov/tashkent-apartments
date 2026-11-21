import { getWithRetry } from '../http.js';
import { detectMarketSegment } from '../marketSegment.js';

// ЧЕТВЁРТЫЙ ИСТОЧНИК: joymee.uz — платформа объявлений о недвижимости
// по Узбекистану. ПОДТВЕРЖДЕНО ВЖИВУЮ 11.08.2026 через DevTools →
// Network на joymee.uz:
//
//   Список:  GET https://api.joymee.uz/api/v1/announcement/
//            ?deal_type=3&region=59&country=1&perPagePlain=N&page=1
//            → { page, total_pages, next, previous, total_count,
//                filtered_count, results: [ {...} ] }
//
//   Деталь:  GET https://api.joymee.uz/api/v1/announcement/{id}/
//            → полный объект объявления (описание, телефон, район,
//              продавец, advertiser_type и т.д.)
//
// Самое важное подтверждённое поле — "advertiser_type" в ОТВЕТЕ
// ДЕТАЛЬНОГО запроса (в списке его НЕТ, только в /announcement/{id}/):
//   advertiser_type: 1 → на странице объявления написано "Кто
//                         разместил: Собственник" (проверено на
//                         объявлении id=287608)
//   advertiser_type: 2 → на странице написано "Агентство"/риелтор
//                         (проверено на объявлении id=390907,
//                         seller.bio = "Агенство Недвижимости...")
// Другие значения не встречались — на всякий случай ТРЕТЬИМ (не
// подтверждённым) значением тоже считаем "не собственник", чтобы не
// пропустить агента по ошибке (см. sellerNameLooksLikeAgent ниже).
//
// ПОДТВЕРЖДЕНО ВЖИВУЮ 11.08.2026 (скриншоты DevTools, вкладка
// "Аренда" на joymee.uz):
//   - deal_type=2 → "Аренда" (длительная, entity_purpose=long_term_rent
//     на /_next/data — соответствует обычной долгосрочной аренде, НЕ
//     посуточной; посуточная — отдельная вкладка "Посуточная" на
//     сайте, её deal_type не проверялся и здесь не используется).
//   - "Дом/Дача" + Аренда → property_type=2, category=5
//   - "Коммерческое" + Аренда → property_type=4, category=6
//
// ПОДТВЕРЖДЕНО ВЖИВУЮ 11.08.2026 (скриншоты DevTools, вкладка
// "Продажа" на joymee.uz):
//   - "Дом/Дача" + Продажа → property_type=2, category=9
//   - "Коммерческое" + Продажа → property_type=4, category=10
//
// ВАЖНЫЙ ВЫВОД из сравнения этих двух наборов скриншотов: property_type
// действительно не зависит от deal_type (2 и 4 совпали для дома и
// коммерции что на продаже, что на аренде) — а вот "category" ЗАВИСИТ
// от deal_type (для дома: 5 при аренде vs 9 при продаже; для
// коммерции: 6 при аренде vs 10 при продаже). Раньше предполагалось
// обратное (что category/property_type — общая ось, не зависящая от
// deal_type) — это предположение оказалось НЕВЕРНЫМ.
//
// ПОДТВЕРЖДЕНО ВЖИВУЮ 11.08.2026 (скриншот DevTools, вкладка "Аренда"
// → "Квартира" на joymee.uz):
//   - "Квартира" + Аренда → property_type=1, category=4
//
// Это ЗАКРЫВАЕТ вопрос из предыдущей версии комментария: category для
// аренды квартир действительно оказалась ДРУГОЙ, чем для продажи (8),
// как и предполагалось по паттерну дом/коммерция. Теперь все 6
// комбинаций (3 типа объекта × sale/rent) подтверждены вживую
// скриншотами DevTools — см. таблицу в JOYMEE_CATEGORY ниже.
//
// Прочие открытые вопросы:
//   - формат URL страницы объявления подтверждён пользователем
//     11.08.2026: https://joymee.uz/ru/announcements/{id}
//   - есть ли отдельная страница "все объявления продавца" (аналог
//     OLX/Uybor) — если да, можно так же считать число объявлений
//     риелтора; пока sellerListingsUrl всегда null.

const JOYMEE_API = 'https://api.joymee.uz/api/v1/announcement/';
const JOYMEE_DETAIL_API = (id) => `https://api.joymee.uz/api/v1/announcement/${id}/`;

// region=59 ("Toshkent shahri") и country=1 ("O'zbekiston") —
// подтверждены вживую (видны в ответах API и в district/region/
// country объектах внутри объявлений).
const JOYMEE_REGION_TASHKENT = 59;
const JOYMEE_COUNTRY_UZ = 1;

// deal_type — подтверждено вживую 11.08.2026: 3 = продажа, 2 = аренда
// (длительная/долгосрочная — entity_purpose=long_term_rent, НЕ
// посуточная).
const JOYMEE_DEAL_TYPE = {
  sale: 3,
  rent: 2,
};

// category/property_type — ВСЕ 6 комбинаций ПОДТВЕРЖДЕНЫ ВЖИВУЮ
// 11.08.2026 через DevTools (см. подробный разбор в шапке файла —
// category зависит от deal_type, property_type — нет):
//
//   sale (deal_type=3):
//     - apartment: property_type=1, category=8
//     - house:     property_type=2, category=9
//     - commercial:property_type=4, category=10
//
//   rent (deal_type=2):
//     - apartment: property_type=1, category=4
//     - house:     property_type=2, category=5
//     - commercial:property_type=4, category=6
const JOYMEE_CATEGORY = {
  sale: {
    apartment: { property_type: 1, category: 8 },
    house: { property_type: 2, category: 9 },
    commercial: { property_type: 4, category: 10 },
  },
  rent: {
    apartment: { property_type: 1, category: 4 },
    house: { property_type: 2, category: 5 },
    commercial: { property_type: 4, category: 6 },
  },
};

// Сколько объявлений забирать за один запрос списка. Не подтверждено
// вживую, что perPagePlain можно задавать произвольно большим — пока
// используем то же значение, что видели в реальных запросах сайта
// (10), чтобы не выглядеть подозрительно на фоне обычного трафика.
const JOYMEE_PER_PAGE = 10;

// Фильтруем "сегодня" И "вчера" — тот же принцип, что у OLX/Uybor (см.
// RECENT_RE в olx.js), двухдневное окно вместо одного дня, решение от
// 12.08.2026. Поле с датой публикации — "ads_at" (подтверждено и в
// списке, и в деталях).
function isRecent(dateStr) {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 1); // начало вчерашнего дня
  cutoff.setHours(0, 0, 0, 0);
  return d >= cutoff;
}

/**
 * @param {'rent'|'sale'} dealType
 * @param {'apartment'|'house'|'commercial'} propertyType
 */
export async function fetchJoymeeListings(dealType = 'rent', propertyType = 'apartment') {
  const dealTypeValue = JOYMEE_DEAL_TYPE[dealType];
  const categoryInfo = JOYMEE_CATEGORY[dealType]?.[propertyType];

  if (dealTypeValue == null) {
    console.warn(`[joymee-${propertyType}-${dealType}] deal_type для "${dealType}" не подтверждён — пропускаю (см. TODO в scrapers/joymee.js)`);
    return [];
  }
  if (!categoryInfo) {
    console.warn(`[joymee-${propertyType}-${dealType}] category/property_type для "${propertyType}"/"${dealType}" не подтверждены — пропускаю (см. TODO в scrapers/joymee.js)`);
    return [];
  }

  const { data } = await getWithRetry(JOYMEE_API, {
    params: {
      deal_type: dealTypeValue,
      property_type: categoryInfo.property_type,
      category: categoryInfo.category,
      region: JOYMEE_REGION_TASHKENT,
      country: JOYMEE_COUNTRY_UZ,
      perPagePlain: JOYMEE_PER_PAGE,
      page: 1,
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  // Подтверждено вживую: объявления лежат в data.results (объект с
  // пагинацией — page/total_pages/next/previous/total_count/
  // filtered_count/results). Оставляем запасные варианты на случай,
  // если структура немного отличается для других параметров.
  const items = data?.results || data?.data || data?.items || (Array.isArray(data) ? data : []);

  console.log(`[joymee-${propertyType}-${dealType}] получено ${items.length} объявлений от API (total_count=${data?.total_count ?? '?'}, filtered_count=${data?.filtered_count ?? '?'})`);
  if (items[0]) {
    console.log(`[joymee-${propertyType}-${dealType}] пример сырого объявления:`, JSON.stringify(items[0]).slice(0, 1200));
  }

  const listings = [];
  for (const item of items) {
    const postedRaw = item.ads_at || '';
    if (!isRecent(postedRaw)) continue;

    const id = item.id;
    if (!id) continue;

    const title = item.title || 'Без названия';

    const priceValue = item.pricing?.price ?? '';
    const priceCurrencyDisplay = item.pricing?.currency_display || '';
    const price = priceValue ? `${Number(priceValue) || priceValue} ${priceCurrencyDisplay}`.trim() : '';

    // advertiser_type (собственник/агентство) в списке НЕ приходит —
    // только в детальном запросе (см. fetchJoymeeDetails ниже,
    // sellerNameLooksLikeAgent). На этапе списка структурного признака
    // нет, поэтому seller_is_organization пока всегда false — решение
    // принимается позже, когда придут детали.
    const sellerIsOrganization = false;
    const sellerName = item.created_by?.full_name || item.created_by?.username || null;

    // Район в списке приходит только как часть текстовой строки
    // address_line ("Toshkent shahri, Yunusobod tumani"), а не как
    // структурный объект (структурный district есть только в
    // деталях) — намеренно НЕ парсим его тут, чтобы не подменить
    // собой более надёжный district.name из fetchJoymeeDetails (см.
    // приоритет источников района в run.js: raw_district не
    // перезаписывается, если уже заполнен).
    const rawDistrict = null;

    const imageUrl = item.image || null;

    listings.push({
      id: `joymee_${id}`,
      source: 'joymee',
      deal_type: dealType,
      property_type: propertyType,
      // Формат подтверждён пользователем 11.08.2026: https://joymee.uz/ru/announcements/{id}
      url: `https://joymee.uz/ru/announcements/${id}`,
      title,
      price,
      posted_raw: postedRaw || 'неизвестно',
      phone_from_api: null, // в списке телефона нет, только в деталях
      seller_is_organization: sellerIsOrganization,
      seller_name: sellerName,
      raw_district: rawDistrict,
      image_url: imageUrl,
    });
  }

  return listings;
}

/**
 * Детали объявления — здесь и только здесь приходит advertiser_type
 * (1 = собственник, всё остальное = не собственник), полный телефон,
 * структурный район (district.name) и описание.
 *
 * ВАЖНО: url приходит из item.url (см. fetchJoymeeListings выше, формат
 * https://joymee.uz/ru/announcements/{id}) — из него достаём числовой id
 * простым regex по последним цифрам пути.
 */
export async function fetchJoymeeDetails(url) {
  const idMatch = String(url || '').match(/(\d+)\/?$/);
  const id = idMatch ? idMatch[1] : null;
  if (!id) {
    console.warn(`[joymee] не удалось извлечь id объявления из URL: ${url}`);
    return { description: '', sellerName: null, sellerListingsUrl: null };
  }

  const { data: item } = await getWithRetry(JOYMEE_DETAIL_API(id), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  // advertiser_type: 1 подтверждено = "Собственник" на странице
  // объявления. Всё, что НЕ строго равно 1 (включая 2 = агентство и
  // любые другие непроверенные значения), намеренно считаем "похоже
  // на агентство" — лучше по ошибке пометить редкого собственника как
  // непроверенного, чем пропустить агентство в уведомления.
  const advertiserType = item?.advertiser_type;
  const sellerNameLooksLikeAgent = advertiserType !== 1;
  if (sellerNameLooksLikeAgent) {
    console.log(`[joymee] объявление ${id}: advertiser_type=${advertiserType} — считаю не собственником`);
  }

  const seller = item?.seller || {};
  const sellerName =
    [seller.first_name, seller.last_name].filter(Boolean).join(' ').trim() ||
    seller.username ||
    null;

  const phone = item?.phone_number || null;

  // Район иногда отсутствует в структурном поле district.name у
  // конкретных объявлений (не баг, просто не заполнено на стороне
  // Joymee) — тогда пробуем резервные поля, которые тоже встречаются
  // в ответах API: address.district.name (вложенный объект адреса),
  // region.district.name (альтернативная вложенность) и текстовую
  // строку адреса (address_line/address_text/location_text — по
  // аналогии с полем из списочного эндпоинта, см. fetchJoymeeListings
  // выше). normalizeDistrict в run.js сам находит нужный район по
  // подстроке, так что достаточно отдать любой текст с упоминанием
  // тумана/района — не обязательно чистое название.
  const locationDistrict =
    item?.district?.name ||
    item?.address?.district?.name ||
    item?.region?.district?.name ||
    item?.address_line ||
    item?.address_text ||
    item?.location_text ||
    null;
  if (!locationDistrict) {
    console.log(`[joymee] объявление ${id}: район не найден ни в одном известном поле ответа API`);
  }

  const priceValue = item?.pricing?.price ?? '';
  const priceCurrencyDisplay = item?.pricing?.currency_display || '';
  const ldPrice = priceValue ? `${Number(priceValue) || priceValue} ${priceCurrencyDisplay}`.trim() : null;

  const imageUrl = extractJoymeeDetailImage(item);
  const imageUrls = Array.isArray(item?.media)
    ? item.media.map((m) => m?.file?.url).filter(Boolean).slice(0, 10)
    : [];

  // См. marketSegment.js — у Joymee, в отличие от Uybor, есть полное
  // description с описанием (item?.description выше), плюс title из
  // списка обычно тоже доступен run.js — но здесь под рукой только
  // описание, этого достаточно.
  const marketSegment = detectMarketSegment(item?.description || item?.title);

  return {
    description: item?.description || '',
    sellerName,
    // TODO: не подтверждено, есть ли у Joymee отдельная страница
    // "все объявления продавца" (как на OLX/Uybor) — пока всегда null.
    sellerListingsUrl: null,
    authorAdsCountHint: null,
    sellerNameLooksLikeAgent,
    locationDistrict,
    phone,
    ldPrice,
    imageUrl,
    imageUrls,
    marketSegment,
  };
}

// Подтверждённая структура: media — массив { file: { url }, order,
// is_cover }. Берём объявленную обложку (is_cover: true), если есть,
// иначе первый элемент по порядку.
function extractJoymeeDetailImage(item) {
  const media = item?.media;
  if (!Array.isArray(media) || media.length === 0) return null;
  const cover = media.find((m) => m?.is_cover) || media[0];
  return cover?.file?.url || null;
}