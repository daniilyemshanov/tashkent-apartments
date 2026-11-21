import { extractImageUrlsFromHtml } from '../postFormat.js';
import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';
import { detectMarketSegment } from '../marketSegment.js';
import { normalizeDistrict } from '../districts.js';

// Тот же паттерн, что и в olx.js (AGENT_NAME_HINT_RE) — вынесен сюда
// отдельной константой, т.к. между scraper-модулями нет общего файла
// для таких мелких хелперов (см. аналогичное решение с districts.js/
// _districts.js — оговорено там же). Ловит компанию/бренд в имени
// продавца ("XYZ Real Estate", "Тошкент Недвижимость" и т.п.) — это
// работает НЕЗАВИСИМО от метки "Частный продавец"/"Агентство" самого
// сайта и от fsbo-фильтра, которые, как показала практика (см. жалобу
// пользователя 20.08.2026 — агентские объявления просачиваются под
// видом собственника даже через /fsbo), сайту доверять не на 100%.
const AGENT_NAME_HINT_RE =
  /риэлтор|риелтор|realtor|\brealty\b|real\s*estate|недвижимост|агентств|\bagency\b|\bagent\b/i;

// У Realting.uz, в отличие от OLX и Uybor, ЕСТЬ готовый встроенный
// фильтр "от собственника" — отдельные SEO-страницы /fsbo (For Sale
// By Owner), уже отфильтрованные сайтом. Подтверждено вживую
// (05.08.2026): /tashkent/apartments/fsbo — 392 квартиры от
// собственников в Ташкенте, есть пагинация ?page=N, карточки уже
// содержат явную метку "Частный продавец" / "Агентство" — то есть
// классификация продавца делается САМИМ сайтом и не требует
// эвристик (в отличие от OLX, где приходится считать объявления
// продавца, см. classify.js).
//
// Для аренды отдельных /fsbo-страниц НЕ существует (только продажа
// размечена так на сайте) — для rent используем обычные страницы
// /tashkent/property-to-rent/{type}. Метка "Частный продавец"/
// "Агентство" на этих страницах ЕСТЬ, но видна ТОЛЬКО на странице
// самого объявления (не в карточке списка) — подтверждено вживую
// 11.08.2026, решение принимается в fetchRealtingDetails/run.js.
//
// Все 6 URL (apartment/house/commercial × sale/rent) подтверждены
// вживую 11.08.2026 скриншотами пользователя — реальные страницы с
// объявлениями.
export const REALTING_CATEGORIES = {
  apartment: {
    sale: 'https://realting.uz/tashkent/apartments/fsbo',
    rent: 'https://realting.uz/tashkent/property-to-rent/apartments',
  },
  house: {
    sale: 'https://realting.uz/tashkent/houses/fsbo', // не проверено вживую
    rent: 'https://realting.uz/tashkent/property-to-rent/houses', // не проверено вживую
  },
  commercial: {
    sale: 'https://realting.uz/tashkent/commercial/fsbo', // не проверено вживую
    rent: 'https://realting.uz/tashkent/property-to-rent/commercials', // не проверено вживую
  },
};

// Ссылки на объявления имеют вид /property/3835137 (продажа) или
// /property-to-rent/3870895 (аренда), /commercial/3861623 и т.п. —
// числовой ID в конце пути, без расширения .html (в отличие от OLX).
// НАЙДЕН БАГ (11.08.2026): CSS-селектор ловил только a[href^="/property/"]
// — не матчил "/property-to-rent/..." (после "property" сразу дефис,
// а не слэш) — для ВСЕЙ аренды linksOnPage.length был 0.
//
// НАЙДЕН ВТОРОЙ БАГ (15.08.2026): сайт сменил вёрстку — href карточек
// стал АБСОЛЮТНЫМ URL ("https://realting.uz/property/3871075"), а не
// относительным путём — CSS-селектор на основе a[href^="/property/"]
// (проверка НАЧАЛА строки) снова перестал матчить вообще всё, теперь
// уже во всех 6 категориях сразу. Диагностировано по логам GitHub
// Actions от пользователя + сверке с реальной HTML-структурой страницы
// (html~580КБ, верный <title> — не заглушка антибота, страница честно
// загрузилась, просто верстка не совпала с CSS-селектором).
//
// ПОСЛЕ ЭТОГО (15.08.2026) убрали CSS-селектор-подстроку совсем —
// он дублировал (и рассинхронизировался с) LISTING_LINK_RE ниже уже
// ДВАЖДЫ за 4 дня. Теперь единственный источник правды — этот regex:
// берём все <a href> на странице через $('a[href]') и фильтруем этим
// же регэкспом (см. extractListingId, используется и для сбора ссылок,
// и внутри подъёма по контейнеру ниже). Единственное, от чего это
// всё ещё зависит — сама структура URL (/property/{id}), а она
// меняется на порядок реже вёрстки/классов.
const LISTING_LINK_RE = /(?:^|\/\/realting\.uz)\/(property-to-rent|property|commercial|short-term-rental)\/(\d+)(?:[/?].*)?$/;
const PRICE_RE = /\$[\d\s.,]+(?:\s?млн)?|[\d\s.,]{3,}\s*(?:UZS|сум|у\.?\s?е\.?)/i;
const MAX_PAGES = 5; // ограничиваем глубину пагинации за один прогон крона

function extractListingId(href) {
  if (!href) return null;
  const m = href.match(LISTING_LINK_RE);
  return m ? m[2] : null;
}

/**
 * @param {'rent'|'sale'} dealType
 * @param {'apartment'|'house'|'commercial'} propertyType
 */
export async function fetchRealtingListings(dealType = 'sale', propertyType = 'apartment') {
  const baseUrl = REALTING_CATEGORIES[propertyType]?.[dealType];
  if (!baseUrl) return [];

  const isFsboPage = dealType === 'sale'; // только продажа размечена сайтом как fsbo
  const seen = new Map();
  let skippedAgents = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    let html;
    try {
      const res = await getWithRetry(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'ru-RU,ru;q=0.9',
          },
          timeout: 15000,
        },
        3,
        true // useProxy — см. диагностику 15.08.2026 в http.js: реалтинг тихо блокирует GH Actions IP
      );
      html = res.data;
    } catch (err) {
      if (page === 1) throw err; // первая страница обязана открыться
      console.warn(`[realting] страница ${page} не открылась (${url}), останавливаюсь:`, err.message);
      break;
    }

    const $ = cheerio.load(html);
    // Раньше отбор ссылок шёл через CSS-селектор (a[href^="..."] /
    // a[href*="..."] — список подстрок, которые нужно было вручную
    // держать в синхроне с LISTING_LINK_RE ниже). Это и было корнем
    // обеих находок 11.08.2026 и 15.08.2026: два источника правды
    // (CSS-селектор и regex) разошлись — сайт поменял формат href
    // (сначала добавил "-to-rent", потом сделал ссылки абсолютными), и
    // CSS-селектор просто перестал совпадать с тем, что реально
    // матчил regex. Теперь источник правды ОДИН — LISTING_LINK_RE:
    // берём вообще ВСЕ ссылки на странице и фильтруем тем же regex,
    // которым потом всё равно достаём ID. Это устойчивее к любым
    // будущим переменам вёрстки/классов — единственное, от чего это
    // всё ещё зависит, это сама структура URL (/property/{id} и т.п.),
    // а она у сайтов меняется на порядок реже, чем разметка/стили.
    const linksOnPage = $('a[href]').filter((_, el) => Boolean(extractListingId($(el).attr('href') || '')));
    if (page === 1) {
      console.log(
        `[realting-${propertyType}-${dealType}] диагностика: html=${html.length} байт, найдено ссылок-кандидатов=${linksOnPage.length}, title="${$('title').text().trim().slice(0, 80)}"`
      );
    }
    if (linksOnPage.length === 0) {
      if (page === 1) {
        // 0 совпадений именно на ПЕРВОЙ странице — подозрительно:
        // страница загрузилась (мы уже прошли getWithRetry выше без
        // ошибки), но ни одной ссылки на объявление не нашлось. Для
        // этих 6 категорий это практически никогда не бывает правдой
        // (сотни объявлений всегда есть) — гораздо вероятнее, что
        // опять поменялась структура URL. РАНЬШЕ это тихо возвращало
        // [] и run.js просто логировал "найдено 0 объявлений" безо
        // всякого алерта (см. `if (items.length === 0) return;` в
        // run.js) — именно из-за этого сбой 15.08.2026 обнаружился
        // только по случайному скриншоту пользователя, а не сам.
        // Бросаем ошибку вместо тихого return — она уйдёт в тот же
        // try/catch в run.js, что и сетевые сбои, и вызовет
        // notifyAlert (теперь лично в личку, см. TELEGRAM_ADMIN_CHAT_ID
        // в telegram.js) — тишина такого рода больше невозможна.
        throw new Error(
          `0 объявлений на странице 1, хотя html=${Math.round(html.length / 1024)}КБ загрузился (title="${$('title').text().trim().slice(0, 80)}") — вероятно, изменилась структура ссылок на сайте`
        );
      }
      break; // страниц 2+ дальше нет — это нормально
    }

    let foundNewOnThisPage = false;

    linksOnPage.each((_, el) => {
      const link = $(el);
      const href = link.attr('href') || '';
      const externalId = extractListingId(href);
      if (!externalId) return;
      if (seen.has(externalId)) return;

      // href теперь бывает и абсолютным ("https://realting.uz/property/123"),
      // и относительным ("/property/123", см. пояснение у LISTING_LINK_RE
      // выше) — нормализуем до относительного пути ПЕРЕД сборкой fullUrl,
      // иначе для абсолютного варианта получится склеенный битый URL
      // вида "https://realting.uzhttps://realting.uz/property/123".
      const hrefPath = href.replace(/^https?:\/\/realting\.uz/, '');
      const fullUrl = `https://realting.uz${hrefPath.split('?')[0]}`;

      // НАЙДЕН ТРЕТИЙ БАГ (19.08.2026): сайт снова поменял вёрстку — теперь
      // <a href="/property/{id}"> оборачивает ВСЮ карточку целиком, включая
      // скрытые модалки ("Показать контакты" со шаблонным текстом "Пожалуйста,
      // скажите продавцу..."), счётчики лайков/суперлайков, все параметры
      // (комнаты/этажи/площадь), кнопку "Рекомендовать" и т.д. — а не только
      // заголовок, как раньше. linkClone.text() при этом ловил ВСЁ это разом,
      // склеенное в один блок с кучей пробелов/переносов (это и было тем самым
      // "мусорным" постом в Telegram, где вместо короткого заголовка шёл
      // огромный текст с рваными пробелами и повторами цены). img[alt] на
      // карточке при этом остаётся чистым и коротким (проверено вживую на
      // #3524567: alt="Дом 4 комнаты 170 м² Ташкент, Узбекистан" — ровно то,
      // что нужно) — теперь он в приоритете. linkClone.text() остаётся только
      // как запасной вариант НА СЛУЧАЙ отсутствия alt, и даже тогда чистится
      // (схлопывание пробелов/переносов + вырезание шаблонной фразы про
      // "скажите продавцу..." + обрезка длины) — чтобы будущая поломка вёрстки
      // портила заголовок не сильнее пары лишних слов, а не рвала весь пост.
      let title = link.find('img').attr('alt')?.trim() || '';
      if (!title) {
        const linkClone = link.clone();
        linkClone.find('style, script').remove();
        title = linkClone
          .text()
          .replace(/Пожалуйста,\s*скажите продавцу[^]*?Realting\.uz/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
      }
      if (!title) return;

      // Как и в olx.js — поднимаемся по родителям, но останавливаемся,
      // как только в контейнере оказывается больше одного уникального
      // ID объявления (значит, вышли за пределы карточки).
      let price = '';
      let sellerTypeText = '';
      let container = link.parent();
      for (let i = 0; i < 8 && container.length; i++) {
        const idsInside = new Set();
        // Тот же принцип, что и у linksOnPage выше: не полагаемся на
        // CSS-подстроки, единственный источник правды — extractListingId
        // (тот же regex). container.find('a[href]') просто даёт кандидатов,
        // extractListingId их фильтрует и проверяет по-настоящему.
        container.find('a[href]').each((_, a) => {
          const id = extractListingId($(a).attr('href') || '');
          if (id) idsInside.add(id);
        });
        if (idsInside.size > 1) break;

        const text = container.text();
        if (!price) {
          const priceMatch = text.match(PRICE_RE);
          if (priceMatch) price = priceMatch[0].trim();
        }
        if (!sellerTypeText && /Частный продавец|Агентство/.test(text)) {
          sellerTypeText = /Частный продавец/.test(text) ? 'owner' : 'agent';
        }
        if (price && sellerTypeText) break;
        container = container.parent();
      }

      // Дешёвая попытка поймать метку прямо в карточке списка — если
      // нашли "Агентство", можно отбросить сразу без похода на
      // страницу объявления. НО (подтверждено вживую 11.08.2026): на
      // страницах аренды (/property-to-rent/...) метка вообще не
      // отображается в карточке списка — видна только на странице
      // самого объявления. Поэтому здесь НЕЛЬЗЯ требовать найденную
      // метку для приёма объявления в rent — иначе вся аренда молча
      // отбрасывается на этом этапе (это и был реальный баг ДО
      // сегодняшнего фикса селектора, из-за которого сюда вообще не
      // доходило ни одной ссылки).
      if (!isFsboPage && sellerTypeText === 'agent') {
        skippedAgents++;
        return;
      }

      foundNewOnThisPage = true;
      seen.set(externalId, {
        id: `realting_${externalId}`,
        source: 'realting',
        deal_type: dealType,
        property_type: propertyType,
        url: fullUrl,
        title,
        price,
        posted_raw: 'неизвестно', // на страницах листинга Realting дата публикации не показана
        // На fsbo-страницах (продажа) сайт САМ гарантирует "от
        // собственника". На rent это ЕЩЁ НЕ подтверждено (метка в
        // карточке списка обычно не видна) — окончательное решение
        // принимается в run.js по данным со страницы объявления
        // (fetchRealtingDetails → sellerType).
        realting_owner_confirmed: isFsboPage || sellerTypeText === 'owner',
        seller_is_organization: false,
      });
    });

    if (!foundNewOnThisPage && page > 1) break; // дошли до дублей/конца — пагинация закончилась
  }

  if (skippedAgents > 0) {
    console.log(`[realting-${dealType}-${propertyType}] пропущено ${skippedAgents} объявлений от агентств`);
  }

  return Array.from(seen.values());
}

/**
 * Заходит на страницу объявления и вытаскивает описание + имя
 * продавца — для дозаписи полного текста (используется классификацией
 * и для поиска телефона в тексте, если он не скрыт).
 * Селекторы описания на детальной странице Realting вживую НЕ
 * подтверждены — ищем по нескольким распространённым вариантам и
 * запасному варианту (самый длинный текстовый блок на странице).
 */
export async function fetchRealtingDetails(url) {
  const { data: html } = await getWithRetry(
    url,
    {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    },
    3,
    true // useProxy — та же блокировка GH Actions IP, что и на странице списка выше
  );
  const $ = cheerio.load(html);

  let description =
    $('[class*="description"]').first().text().trim() ||
    $('[itemprop="description"]').first().text().trim();

  // 19.08.2026: фолбэк "самый длинный текстовый блок" иногда ловил не
  // абзац описания, а соседний служебный блок страницы (цена/счётчик
  // фото/кнопка "Рекомендовать" — всё это лежит рядом с описанием в
  // одном родительском div и суммарно текста там больше, чем в самом
  // описании). Признак такого блока — он состоит из коротких строк-
  // ярлыков интерфейса, а не связного текста продавца. Отсекаем два
  // источника ложных срабатываний:
  //  1) явные фразы интерфейса Realting, которые не может написать
  //     продавец в описании;
  //  2) блоки без единого предложения (нет точки/запятой И длиннее
  //     одного слова) — реальное описание почти всегда хотя бы одно
  //     предложение, а ярлыки типа "Цена по запросу"/"1"/"Рекомендовать"
  //     идут короткими строками без пунктуации.
  const UI_CHROME_RE = /Рекомендовать|Цена по запросу|Показать номер|Написать продавцу|^\d+$/im;

  function looksLikeRealDescription(text) {
    if (!text || text.length < 40) return false;
    if (UI_CHROME_RE.test(text)) return false;
    const hasSentencePunctuation = /[.,!?]/.test(text);
    const hasMultipleWords = text.trim().split(/\s+/).length >= 6;
    return hasSentencePunctuation && hasMultipleWords;
  }

  if (!looksLikeRealDescription(description)) {
    // запасной вариант: самый длинный текстовый блок на странице,
    // который при этом реально похож на описание (см. выше), а не на
    // обрывок интерфейса.
    let longest = '';
    $('div, p').each((_, el) => {
      const t = $(el).clone().children().remove().end().text().trim();
      if (looksLikeRealDescription(t) && t.length > longest.length && t.length < 3000) longest = t;
    });
    if (longest) description = longest;
  }

  const sellerName =
    $('[class*="seller"] [class*="name"]').first().text().trim() ||
    $('[class*="agent-name"]').first().text().trim() ||
    $('.company-info-desc .company-title').first().text().trim() ||
    null;

  // Простая, дешёвая проверка независимая от метки сайта: если имя/
  // название продавца само по себе звучит как компания/риелтор —
  // считаем это агентом, даже если страница (или fsbo-фильтр) говорит
  // "Частный продавец". См. AGENT_NAME_HINT_RE выше. run.js уже умеет
  // читать это поле для ЛЮБОГО источника (см. sellerNameLooksLikeAgent
  // в run.js, изначально сделано для OLX/Joymee/DomTut) — здесь просто
  // подключаем Realting к тому же самому общему механизму.
  const sellerNameLooksLikeAgent = Boolean(sellerName && AGENT_NAME_HINT_RE.test(sellerName));

  // Метка "Частный продавец"/"Агентство" на странице объявления —
  // подтверждено вживую 11.08.2026 (реальный HTML страницы): лежит в
  // блоке продавца, например <div class="color-dark">Частный
  // продавец</div><div class="company-title">Имя</div>. На страницах
  // аренды это ЕДИНСТВЕННОЕ место, где эта метка вообще видна (в
  // карточке списка её нет) — используется как основной сигнал в
  // run.js для isConfirmedOwner/isConfirmedAgent.
  const pageText = $('body').text();
  let sellerType = null;
  if (/Частный продавец/.test(pageText)) sellerType = 'owner';
  else if (/Агентство/.test(pageText)) sellerType = 'agent';

  // Район — структурный блок "Местонахождение" (подтверждено вживую
  // 11.08.2026, реальный HTML): список <li><div class="lh-small">
  // <div class="fs-small color-dark">Район</div><div>ЗНАЧЕНИЕ</div>
  // </div></li> внутри #blockAddress.
  let locationDistrict = null;
  $('#blockAddress li .lh-small').each((_, el) => {
    const label = $(el).children().eq(0).text().trim();
    if (label === 'Район') {
      locationDistrict = $(el).children().eq(1).text().trim() || null;
    }
  });

  // 20.08.2026: жалоба пользователя — район с Realting часто не
  // вытягивается. Структурный блок #blockAddress не всегда есть на
  // странице (сайт то и дело меняет вёрстку, см. историю багов выше
  // по файлу) — вместо того чтобы просто отдавать null, пробуем ещё
  // два узких, безопасных источника, ПРЕЖДЕ чем сдаться:
  //  1) og:title / meta title / <title> — Realting почти всегда
  //     пишет туда полный адрес вида "3-комн. квартира, Юнусабадский
  //     район, Ташкент" — короткая строка, поэтому риск случайно
  //     задеть чужой район (например из меню-фильтра) минимальный.
  //  2) хлебные крошки (breadcrumbs) — тоже короткий, предсказуемый
  //     список ссылок, а не весь body.
  // Специально НЕ используем normalizeDistrict(pageText) по всему
  // телу страницы — там почти наверняка есть меню/фильтр со списком
  // ВСЕХ районов сразу, и совпадёт первый по порядку в DISTRICTS, а
  // не тот, что реально относится к объявлению.
  if (!locationDistrict) {
    const titleText =
      $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    locationDistrict = normalizeDistrict(titleText);
  }
  if (!locationDistrict) {
    const breadcrumbsText = $('[class*="breadcrumb"]').text();
    locationDistrict = normalizeDistrict(breadcrumbsText);
  }

  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  const imageUrls = extractImageUrlsFromHtml($);

  // См. marketSegment.js — ищем по всему тексту страницы, как и
  // sellerType чуть выше (тот же pageText, дополнительных запросов не
  // нужно).
  const marketSegment = detectMarketSegment(pageText);

  return {
    description,
    sellerName: sellerName || null,
    sellerListingsUrl: null,
    imageUrl,
    sellerType,
    sellerNameLooksLikeAgent,
    locationDistrict,
    marketSegment,
  };
}
