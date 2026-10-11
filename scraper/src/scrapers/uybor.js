import { getWithRetry } from '../http.js';
import { detectMarketSegment } from '../marketSegment.js';

// Найдено через DevTools → Network → Fetch/XHR на uybor.uz.
// operationType__eq принимает 'rent' | 'sale' напрямую — совпадает
// с нашими значениями dealType, поэтому передаём как есть.
const UYBOR_API = 'https://api.uybor.uz/api/v1/listings';

const REGION_TASHKENT = 13;

// Подтверждено вживую 11.08.2026 через GET api.uybor.uz/api/v1/listings/categories
// (полный список категорий сайта). Дом (id=8) и "Для бизнеса" (id=10) —
// это ВЕРХНЕУРОВНЕВЫЕ категории, у каждой есть свои подкатегории
// (Дом → Частный дом/Дача/Коттедж; Для бизнеса → Офис/Склад/Производство/
// Готовый бизнес/Здание), но в фильтре на сайте выбор идёт именно по
// этим родительским ID одним пунктом ("Дом", "Для бизнеса") — как и с
// квартирами, поэтому используем ID родителя напрямую.
const CATEGORY_BY_PROPERTY_TYPE = {
  apartment: 7,
  house: 8,
  commercial: 10,
};

/**
 * Uybor отдаёt некоторые текстовые поля (в т.ч. похоже, title) не
 * простой строкой, а объектом с переводами вида {ru: "...", uz: "...",
 * "uz-latn": "..."}. Эта функция достаёт из такого объекта читаемую
 * строку; если значение уже строка — просто возвращает её как есть.
 */
function localized(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return (
      value.ru || value.uz || value['uz-latn'] || value.en ||
      Object.values(value).find((v) => typeof v === 'string' && v.trim()) ||
      ''
    );
  }
  return String(value);
}

// Слова, которыми Uybor подписывает НЕ-частных продавцов прямо на
// странице объявления (см. скриншот: под именем продавца написано
// "Риелтор"). Замечено, что поле item.user?.organization в API часто
// пустое даже для таких продавцов — сайт хранит это отдельным полем
// "роль"/"тип аккаунта", точное имя которого в JSON не подтверждено,
// поэтому проверяем сразу несколько вероятных вариантов + текстовое
// совпадение по любому строковому полю пользователя.
const AGENT_ROLE_WORDS = ['риелтор', 'риэлтор', 'агент', 'agent', 'realtor', 'dealer', 'compan', 'agency', 'brok'];

function textLooksLikeAgent(value) {
  const s = localized(value).toLowerCase();
  return s ? AGENT_ROLE_WORDS.some((w) => s.includes(w)) : false;
}

/**
 * Определяет, что продавец — НЕ частник (риелтор/агентство), а не
 * только по item.user?.organization (которое, судя по скриншоту,
 * не всегда заполнено). Проверяет несколько вероятных полей "роли"
 * плюс текстовое совпадение по всем строковым полям user-объекта.
 */
function detectAgentRole(item) {
  const user = item.user || {};

  if (user.organization) {
    return { isAgent: true, roleText: localized(user.organization.name) || localized(user.organization.title) || 'organization' };
  }

  // Вероятные названия поля "роль"/"тип аккаунта" — точное имя не
  // подтверждено без реального ответа API, поэтому пробуем все.
  const roleCandidates = [
    user.role,
    user.roleName,
    user.userRole,
    user.userType,
    user.accountType,
    user.type,
    user.category,
    user.position,
    user.title,
    user.badge,
    user.label,
    item.userRole,
    item.role,
  ];
  for (const candidate of roleCandidates) {
    if (candidate && textLooksLikeAgent(candidate)) {
      return { isAgent: true, roleText: localized(candidate) };
    }
  }

  // Последний рубеж: пробегаем по всем строковым значениям объекта
  // user целиком — если Uybor называет поле как-то ещё, слово
  // "риелтор"/"агент" всё равно должно где-то встретиться.
  for (const value of Object.values(user)) {
    if (typeof value === 'string' && textLooksLikeAgent(value)) {
      return { isAgent: true, roleText: value };
    }
  }

  return { isAgent: false, roleText: null };
}

// Дата публикации — фильтруем так же, как и OLX (см. RECENT_RE в
// olx.js): "сегодня" И "вчера", а не только сегодня — двухдневное
// окно, решение от 12.08.2026, снижает риск пропустить объявление
// из-за задержки/сбоя прогона скрапера (раз в 15 минут).
function isRecent(dateStr) {
  if (!dateStr) return true; // не нашли дату — лучше показать, чем упустить
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
export async function fetchUyborListings(dealType = 'rent', propertyType = 'apartment') {
  const categoryId = CATEGORY_BY_PROPERTY_TYPE[propertyType];
  if (!categoryId) {
    console.warn(`[uybor] неизвестный propertyType "${propertyType}", пропускаю`);
    return [];
  }

  const { data } = await getWithRetry(UYBOR_API, {
    params: {
      mode: 'search',
      limit: 30,
      order: 'upAt',
      operationType__eq: dealType,
      category__eq: categoryId,
      region__eq: REGION_TASHKENT,
      embed: 'media,user,district,region',
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  // Структура ответа пока не проверена вживую — поддерживаем
  // несколько вариантов на случай, если объявления лежат не в
  // data.data, а в другом поле.
  const items = data?.data || data?.items || data?.results || (Array.isArray(data) ? data : []);

  console.log(`[uybor-${propertyType}-${dealType}] получено ${items.length} объявлений от API`);
  if (items[0]) {
    // Debug-лог первого объявления целиком — если какие-то поля ниже
    // окажутся пустыми/неверными, этот вывод покажет реальную структуру,
    // и поля будет легко поправить.
    console.log(`[uybor-${propertyType}-${dealType}] пример сырого объявления:`, JSON.stringify(items[0]).slice(0, 1200));
    // Отдельно логируем именно user — это где живёт роль
    // ("Риелтор"/"Агент"), которую мы сейчас пытаемся поймать.
    console.log(`[uybor-${propertyType}-${dealType}] user первого объявления:`, JSON.stringify(items[0].user || null));
  }

  const listings = [];
  for (const item of items) {
    const postedRaw = item.upAt || item.createDate || item.updateDate || '';
    if (!isRecent(postedRaw)) continue;

    const id = item.id ?? item._id;
    if (!id) continue;

    const title =
      localized(item.title) ||
      localized(item.name) ||
      [localized(item.category?.name), localized(item.district?.name)].filter(Boolean).join(', ') ||
      'Без названия';

    const priceValue = item.price ?? item.priceEquivalent ?? '';
    const priceCurrency = item.priceCurrency || 'usd';
    const price = priceValue ? `${priceValue} ${priceCurrency === 'usd' ? 'у.е.' : 'сум'}` : '';

    const phone = item.user?.phone || item.phone || item.contactPhone || null;

    // Uybor различает частных продавцов и риелторов/агентства — но,
    // как показал реальный прогон (см. скриншот с "Риелтор" под именем
    // продавца), одного item.user?.organization для этого недостаточно.
    // detectAgentRole() проверяет organization + несколько вероятных
    // полей "роли" + текстовое совпадение по всем строковым полям user.
    const { isAgent: sellerIsOrganization, roleText: sellerRoleText } = detectAgentRole(item);
    const orgName = localized(item.user?.organization?.name) || localized(item.user?.organization?.title) || null;
    const sellerName = orgName || item.user?.name || item.user?.fullName || null;
    if (sellerIsOrganization) {
      console.log(`[uybor-${propertyType}-${dealType}] продавец "${sellerName || '?'}" помечен как риелтор/агентство (${sellerRoleText})`);
    }

    // Uybor отдаёт район структурно (через ?embed=district) — самый
    // надёжный источник района из всех сайтов, используем напрямую,
    // без необходимости в ИИ-классификации или поиске по тексту.
    // См. normalizeDistrict() в run.js, который приводит это к
    // каноничному названию.
    const rawDistrict = localized(item.district?.name) || null;

    // media уже запрашивается через embed=media (см. UYBOR_API выше),
    // просто раньше это поле нигде не читалось. Точный формат объекта
    // media НЕ подтверждён вживую — пробуем несколько вероятных
    // вариантов полей; если ни один не сработает, просто не будет
    // картинки у Uybor-объявлений (не критично, не блокирует остальное).
    const imageUrl = extractUyborImage(item);
    if (item === items[0]) {
      console.log(`[uybor-${propertyType}-${dealType}] media первого объявления:`, JSON.stringify(item.media || null).slice(0, 400));
    }

    listings.push({
      id: `uybor_${id}`,
      source: 'uybor',
      deal_type: dealType,
      property_type: propertyType,
      // Точный формат URL объявления на uybor.uz не подтверждён —
      // если ссылка окажется нерабочей, поправить тут после проверки.
      url: `https://uybor.uz/listings/${id}`,
      title,
      price,
      posted_raw: postedRaw || 'неизвестно',
      phone_from_api: phone,
      seller_is_organization: sellerIsOrganization,
      seller_name: sellerName,
      raw_district: rawDistrict,
      image_url: imageUrl,
      // Best-effort: у Uybor нет отдельного поля "новостройка/вторичка",
      // подтверждённого вживую (fetchUyborDetails ниже даже не тянет
      // описание, см. комментарий там) — поэтому ищем явную фразу
      // только в title. Реже сработает, чем на OLX, но лучше, чем
      // ничего, и безопасно молчит (null), если фразы нет — см.
      // marketSegment.js.
      market_segment: detectMarketSegment(title),
    });
  }

  return listings;
}

/**
 * media от Uybor API — формат не подтверждён вживую, пробуем несколько
 * вероятных структур (массив строк / массив объектов с url|path|src).
 * Относительные пути достраиваем до полного URL.
 */
function extractUyborImage(item) {
  const media = item.media || item.images || item.photos;
  if (!Array.isArray(media) || media.length === 0) return null;
  const first = media[0];
  const candidate = typeof first === 'string' ? first : first?.url || first?.path || first?.src || first?.image || null;
  if (!candidate) return null;
  if (candidate.startsWith('http')) return candidate;
  return `https://api.uybor.uz${candidate.startsWith('/') ? '' : '/'}${candidate}`;
}

/**
 * Раньше отдельный запрос за деталями не делался вообще (детали не
 * подтягивались, raw_text = только title) — из-за этого у Uybor не
 * было ни полноценной классификации собственник/агент по тексту, ни
 * материала для текстового поиска (жалоба пользователя 24.08.2026:
 * "чтобы иишка тоже могла искать по описаниям" — а описания на Uybor
 * попросту нигде не лежали). Теперь дозапрашиваем
 * GET /api/v1/listings/{id} — тот же JSON API, что и список, просто
 * по одному объявлению.
 *
 * ВАЖНО: формат ответа этой конкретной ручки НЕ подтверждён вживую
 * (в отличие от /listings — см. debug-лог там от 11.08.2026). Логируем
 * сырой ответ ПЕРВОГО запроса за прогон (loggedSample) — по нему после
 * деплоя нужно свериться в логах GitHub Actions, что description
 * реально достаётся, и поправить поле, если название другое.
 */
let loggedSample = false;

export async function fetchUyborDetails(url) {
  const idMatch = String(url || '').match(/\/listings\/(\d+)/);
  const id = idMatch ? idMatch[1] : null;
  if (!id) return { description: '', sellerName: null, sellerListingsUrl: null };

  try {
    const { data } = await getWithRetry(
      `${UYBOR_API}/${id}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 15000,
      },
      3
    );

    const item = data?.data || data;
    if (!loggedSample) {
      loggedSample = true;
      console.log(`[uybor-details] сырой ответ /listings/${id}:`, JSON.stringify(item).slice(0, 1500));
    }

    // Поле описания не подтверждено — пробуем несколько вероятных
    // названий (описание у Uybor, как и title, скорее всего
    // локализованный объект {ru,uz,"uz-latn"} — см. localized() выше).
    const description = localized(item?.description) || localized(item?.text) || localized(item?.body) || '';

    const { isAgent: sellerNameLooksLikeAgent } = item?.user ? detectAgentRole(item) : { isAgent: false };
    const orgName = localized(item?.user?.organization?.name) || localized(item?.user?.organization?.title) || null;
    const sellerName = orgName || item?.user?.name || item?.user?.fullName || null;

    return { description, sellerName, sellerListingsUrl: null, sellerNameLooksLikeAgent };
  } catch (err) {
    console.warn(`[uybor] не удалось получить детали объявления ${id}:`, err.message);
    return { description: '', sellerName: null, sellerListingsUrl: null };
  }
}
