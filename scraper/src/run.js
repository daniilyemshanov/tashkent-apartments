import 'dotenv/config';
import { fetchOlxListings, fetchOlxDetails, fetchOlxSellerListingsCount, isPlausiblePrice } from './scrapers/olx.js';
import { fetchUyborListings, fetchUyborDetails } from './scrapers/uybor.js';
import { fetchRealtingListings, fetchRealtingDetails } from './scrapers/realting.js';
import { fetchDomtutListings, fetchDomtutDetails } from './scrapers/domtut.js';
// Joymee: endpoint и структура ответа подтверждены вживую 11.08.2026
// через DevTools (см. шапку scrapers/joymee.js). Включена в main()
// пока только для продажи квартир — единственной подтверждённой
// комбинации deal_type/category; аренда и дома/коммерция ждут своих
// TODO там же.
import { fetchJoymeeListings, fetchJoymeeDetails } from './scrapers/joymee.js';
import { classifyListing, labelFor, SELLER_LISTINGS_AGENT_THRESHOLD } from './classify.js';
import { notifyAlert, notifyToTopicGroup, notifyDeal } from './telegram.js';
import {
  getListingById,
  getLatestListingByEntityKey,
  saveListing,
  markNotified,
  countListingsByPhone,
} from './db.js';
import { normalizeDistrict } from './districts.js';
import { parsePrice, toUsd } from './priceParser.js';
import { cleanAgentBacklog } from './cleanAgentMessages.js';
import { findAgentTextSignal } from './agentSignals.js';
import { normalizePhone } from './phone.js';
import { extractListingInfo, extractListingInfoRegexOnly } from './extractListingInfo.js';
import { isProviderActiveThisRun } from './aiProviders.js';
import { findUrgencySignal } from './urgencySignals.js';
import { refreshMarketStatsIfStale, loadMarketStatsMap, evaluateDeal } from './marketStats.js';
import { detectMarketSegment } from './marketSegment.js';
import {
  makeEntityKey,
  summarizePriceHistory,
  computeOwnerScore,
  computeDealScore,
  shouldNotifyDealCandidate,
  isSignificantPriceChange,
  isDuplicatePriceChange,
} from './dealScoring.js';

// Тот же курс, что и в marketStats.js (см. пояснение там) — нужен тут
// для санити-проверки price_per_sqm ниже, ДО того как значение вообще
// попадёт в базу.
const EXCHANGE_RATE_USD_UZS = Number(process.env.EXCHANGE_RATE_USD_UZS) || 12700;

// Сколько ДРУГИХ объявлений с тем же номером телефона считаем
// подозрительным порогом (см. countListingsByPhone в db.js). Не 0
// (одна штука), потому что частник иногда честно перевыкладывает ТУ
// ЖЕ квартиру повторно, если её долго не покупают/не снимают — это
// нормально и не должно клеймить его агентом. От 2 прежних объявлений
// с одним номером — уже гораздо больше похоже на агентство, чем на
// повторную публикацию одного и того же объекта.
const PHONE_REUSE_AGENT_THRESHOLD = 2;

// Между вызовами extractListingInfo (LLM) — пауза, чтобы не упереться
// в лимит бесплатного тира Gemini (10 запросов/мин). БЫЛО 7000мс
// (~8.5 запросов/мин с запасом) — но это означало, что при большом
// числе НОВЫХ объявлений за один прогон (после паузы, наплыва и т.п.)
// скрапер не успевал пройти все source×propertyType×dealType
// комбинации за timeout-minutes из scrape.yml: пауза применяется на
// каждое новое объявление, пока circuit breaker явно не отключит
// Gemini на этот прогон (после 3 подряд 429/402), а не только когда
// Gemini реально отвечает — то есть почти всегда, даже если конкретный
// вызов в итоге обслужил Groq/Mistral/... .
// 13.09.2026: снижено до 2000мс (~30 запросов/мин) — это ЧАЩЕ лимита
// Gemini, но это осознанно: как только квота исчерпана, 429 приходят
// быстро (не таймаутом) и почти гарантированно ПОДРЯД, так что breaker
// в aiProviders.js отключает Gemini на весь остаток прогона за 3
// быстрых неудачных попытки — и дальше вся очередь новых объявлений
// идёт через быстрые провайдеры без всякой паузы вообще (см. ветку
// LLM_EXTRACT_DELAY_MS_NO_GEMINI ниже). Цена — горстка потраченных
// впустую (но быстрых) 429-запросов к Gemini один раз за прогон,
// вместо многих минут искусственного ожидания на каждом объявлении.
// Если понадобится точнее настроить — можно переопределить через
// секрет LLM_EXTRACT_DELAY_MS в GitHub Actions (env уже прокинут).
const LLM_EXTRACT_DELAY_MS = Number(process.env.LLM_EXTRACT_DELAY_MS) || 2000;
// Как только Gemini отключается circuit breaker'ом на этот прогон
// (см. aiProviders.js) — длинная пауза больше не нужна, она была
// нужна только ради его лимита. Groq/OpenRouter не настолько строгие,
// короткой паузы достаточно, чтобы не долбить их слишком часто.
const LLM_EXTRACT_DELAY_MS_NO_GEMINI = Number(process.env.LLM_EXTRACT_DELAY_MS_NO_GEMINI) || 1500;

const PHONE_REGEX = /(\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/;
const DEAL_SCORE_MIN_MARKET_COMPONENT = Number(process.env.DEAL_SCORE_MIN_MARKET_COMPONENT) || 10;
const REALTING_ENABLED = process.env.REALTING_ENABLED !== 'false';
const DOMTUT_ENABLED = process.env.DOMTUT_ENABLED !== 'false';

const detailsCache = new Map();
const sellerCountCache = new Map();
const entityLookupCache = new Map();
const phoneCountCache = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getCachedDetails(fetchDetails, url) {
  const key = `${fetchDetails.name || 'details'}:${url}`;
  if (detailsCache.has(key)) return detailsCache.get(key);
  const promise = Promise.resolve(fetchDetails(url)).catch((err) => {
    detailsCache.delete(key);
    throw err;
  });
  detailsCache.set(key, promise);
  return promise;
}

async function getCachedSellerCount(fetchSellerCount, url) {
  const key = `${fetchSellerCount.name || 'sellerCount'}:${url}`;
  if (sellerCountCache.has(key)) return sellerCountCache.get(key);
  const promise = Promise.resolve(fetchSellerCount(url)).catch((err) => {
    sellerCountCache.delete(key);
    throw err;
  });
  sellerCountCache.set(key, promise);
  return promise;
}

function looksLikePersonName(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  if (/(agency|estate|realty|company|group|недвиж|риелт|агентств|broker)/i.test(text)) return false;
  return /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\s'.-]{1,50}$/.test(text);
}

// Между тремя запросами подряд к OLX (квартиры/дома/коммерция) делаем
// паузу — иначе это выглядит как классический паттерн бота ("три
// одинаковых запроса без пауз ровно каждые 15 минут"), и, похоже,
// именно это триггерило блокировку 403 всю ночь 11.08.2026 (только у
// sale, потому что sale всегда идёт первой пачкой в каждом цикле,
// а к моменту rent проверка уже "размазана" по времени за счёт
// обработки Uybor/Realting между ними).
async function olxDelay() {
  await sleep(5000 + Math.floor(Math.random() * 4000)); // 5-9с с разбросом
}

// ИИ-классификация отключена по решению (05.08.2026) — весь проект
// теперь работает только на жёстких правилах (много объявлений у
// продавца / аккаунт-организация / метка сайта), без обращения к
// Anthropic API. Код классификации (classify.js, ветка ниже) НЕ
// удалён — просто эта константа жёстко зафиксирована в false, так
// что ветка с classifyListing() больше не выполняется, даже если
// кто-то случайно оставит USE_AI_CLASSIFICATION=true в GitHub Secrets.
// Если понадобится снова включить ИИ — верните строку ниже на
// `process.env.USE_AI_CLASSIFICATION === 'true'`.
const USE_AI_CLASSIFICATION = false;

async function processSource(fetchList, fetchDetails, sourceName, dealType, fetchSellerCount = null, propertyType = 'apartment', marketStatsMap = null) {
  const sourceLabel = `${sourceName}-${propertyType}-${dealType}`;
  console.log(`[${sourceLabel}] проверяю новые объявления...`);

  let items = [];
  try {
    items = await fetchList(dealType, propertyType);
  } catch (err) {
    console.error(`[${sourceLabel}] ошибка при получении списка:`, err.message);
    await notifyAlert(
      `⚠️ ${sourceLabel}: не удалось загрузить список объявлений после нескольких попыток (${err.message}).`
    );
    return;
  }

  console.log(`[${sourceLabel}] найдено ${items.length} объявлений (за 2 дня) на странице`);
  if (items.length === 0) return;

  // Счётчики для само-диагностики этого прогона — цель: если сайт
  // тихо поменяет вёрстку и жёсткое правило "риэлтор по числу
  // объявлений" перестанет срабатывать, мы должны узнать об этом из
  // Telegram-алерта в течение 15 минут, а не из жалобы через
  // несколько дней (см. баг 08.08.2026 — ссылка на профиль продавца
  // перестала находиться, риэлторы пошли как собственники, и это
  // никак не было видно, пока кто-то не заметил руками).
  let sellerLinkMissingCount = 0;
  let sellerCheckedCount = 0;
  // Circuit breaker: если сайт-источник блокирует/тормозит буквально
  // КАЖДЫЙ запрос к странице объявления (см. инцидент 19.08.2026 —
  // Domtut, судя по всему, начал массово ронять запросы с IP GitHub
  // Actions, и прогон, вместо того чтобы быстро сдаться, честно
  // отрабатывал retry+backoff (getWithRetry, до ~47с на URL) на
  // КАЖДОМ из десятков объявлений подряд — один прогон растянулся на
  // часы, следующие триггеры cron-job.org накапливались друг на
  // друга, потому что в scrape.yml нет concurrency-группы, и в итоге
  // объявления не доходили ни в Telegram, ни на сайт часами). Если
  // подряд не удаётся получить details для нескольких объявлений
  // ПОДРЯД — почти наверняка источник блокирует нас целиком на этом
  // прогоне, а не единичный сбой сети. Останавливаем этот источник
  // прямо сейчас, остальные его объявления просто попробуются
  // заново в следующем прогоне (через 15 минут) — так безопаснее,
  // чем упрямо жечь время на заведомо обречённые запросы.
  const DETAILS_CIRCUIT_BREAKER_THRESHOLD = 8;
  let consecutiveDetailFailures = 0;
  let circuitBreakerTripped = false;

  for (const item of items) {
    if (circuitBreakerTripped) break;
    const existingById = await getListingById(item.id);
    const listPrice = parsePrice(item.price);
    const hasBackfilledScoring =
      existingById?.deal_score != null && existingById?.owner_score != null && existingById?.price_history_count != null;
    const sameKnownPrice =
      existingById &&
      existingById.price_value != null &&
      listPrice.value != null &&
      Number(existingById.price_value) === Number(listPrice.value) &&
      String(existingById.price_currency || '').toUpperCase() === String(listPrice.currency || '').toUpperCase();
    if (existingById && sameKnownPrice && hasBackfilledScoring) continue;

    let rawText = item.title;
    let sellerName = null;
    let sellerListingsUrl = null;
    let authorAdsCountHint = null;
    let sellerNameLooksLikeAgent = false;
    let detailsFetchFailed = false;
    // "Новостройка"/"вторичный рынок" — см. marketSegment.js. Uybor
    // уже определяет это на этапе списка (fetchUyborListings, только
    // title доступен там), остальные источники — на этапе деталей
    // (details.marketSegment ниже, там доступно полное описание).
    let marketSegment = item.market_segment ?? null;
    try {
      const details = await getCachedDetails(fetchDetails, item.url);
      if (details?.description) rawText = `${item.title}\n${details.description}`;
      if (details?.marketSegment) marketSegment = details.marketSegment;
      sellerName = details?.sellerName || item.seller_name || null;
      sellerListingsUrl = details?.sellerListingsUrl || null;
      authorAdsCountHint = details?.authorAdsCountHint ?? null;
      sellerNameLooksLikeAgent = details?.sellerNameLooksLikeAgent || false;
      // Realting rent: метка "Частный продавец"/"Агентство" видна
      // только на странице объявления (см. fetchRealtingDetails →
      // sellerType), а не в карточке списка — подтверждаем/опровергаем
      // item.realting_owner_confirmed здесь, а не доверяем вслепую.
      if (item.source === 'realting' && !item.realting_owner_confirmed) {
        if (details?.sellerType === 'owner') item.realting_owner_confirmed = true;
        else if (details?.sellerType === 'agent') item.realting_owner_confirmed = 'agent';
      }
      if (sourceName === 'olx' && fetchSellerCount) {
        sellerCheckedCount++;
        if (!sellerListingsUrl) {
          sellerLinkMissingCount++;
          // Раньше это никак не логировалось — если OLX поменяет вёрстку
          // кнопки "все объявления автора", проверка на риэлтора молча
          // не срабатывает, и агент просто проходит как "непонятно".
          console.warn(
            `[${sourceLabel}] не нашли ссылку на профиль продавца "${sellerName || '?'}" — проверка числа объявлений пропущена: ${item.url}`
          );
        }
      }
      // Телефон со страницы объявления (пока реализовано только для
      // OLX, см. fetchOlxDetails) — приоритетнее, чем поиск номера в
      // тексте, потому что это самое надёжное поле, когда доступно.
      if (details?.phone) item.phone_from_details = details.phone;
      // Цена из JSON-LD (см. fetchOlxDetails) — надёжнее, чем то, что
      // нашлось при скрапинге списка (структурные данные, а не парсинг
      // вёрстки). Предпочитаем её везде, КРОМЕ коммерции — там
      // offers.price на OLX иногда указан "за м²", а не общей суммой,
      // так что для коммерции берём её только как подстраховку, если
      // со страницы списка цена вообще не нашлась.
      //
      // ВАЖНО (найдено 12.08.2026): раньше ldPrice перезаписывал цену
      // БЕЗ проверки isPlausiblePrice() — а её тоже иногда заносит
      // (наблюдались реальные случаи вида "5 у.е.", "12 у.е." на
      // аренде квартир — судя по всему, OLX сам иногда отдаёт в
      // JSON-LD какое-то служебное/неполное число, не настоящую цену).
      // Раньше цена со страницы списка (которая КАК РАЗ уже проходила
      // isPlausiblePrice в fetchOlxListings) тихо перетиралась этим
      // мусором. Теперь ldPrice тоже обязан пройти ту же проверку —
      // если не проходит, просто не используем её, остаётся то, что
      // было найдено (и уже провалидировано) на странице списка.
      if (details?.ldPrice && isPlausiblePrice(details.ldPrice, dealType)) {
        if (propertyType !== 'commercial' || !item.price) {
          item.price = details.ldPrice;
        }
      }
      // Структурное поле "район" со страницы объявления (сейчас — блок
      // "МЕСТОПОЛОЖЕНИЕ" на OLX, см. fetchOlxDetails). У Uybor
      // raw_district уже выставлен на этапе списка (fetchUyborListings),
      // так что тут его не перезаписываем.
      if (details?.locationDistrict && !item.raw_district) item.raw_district = details.locationDistrict;
      if (details?.imageUrl && !item.image_url) item.image_url = details.imageUrl;
      consecutiveDetailFailures = 0;
    } catch (err) {
      detailsFetchFailed = true;
      console.warn(`[${sourceLabel}] не удалось получить текст объявления ${item.url}:`, err.message);
      consecutiveDetailFailures++;
      if (consecutiveDetailFailures >= DETAILS_CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerTripped = true;
        console.error(
          `[${sourceLabel}] ${consecutiveDetailFailures} объявлений подряд не удалось открыть — похоже, источник блокирует этот прогон целиком. Останавливаю ${sourceLabel} досрочно, оставшиеся объявления попробуются в следующем прогоне.`
        );
        await notifyAlert(
          `⚠️ [${sourceLabel}] ${consecutiveDetailFailures} объявлений подряд не открылись (похоже на блокировку источника) — прогон источника остановлен досрочно, чтобы не тратить часы на заведомо обречённые запросы. Оставшиеся объявления попробуются в следующем прогоне через 15 минут.`
        );
      }
    }

    // Последний, самый дешёвый шанс поймать сегмент — по итоговому
    // rawText (title+description), даже если конкретный источник его
    // не нашёл (например, fetchDetails упал — see catch выше — но
    // item.title сам по себе уже содержит фразу).
    if (!marketSegment) marketSegment = detectMarketSegment(rawText);

    const phoneMatch = rawText.match(PHONE_REGEX);
    const phoneFromText = phoneMatch ? phoneMatch[1] : null;
    const phoneFromApi = item.phone_from_api || null;
    const effectivePhone = item.phone_from_details || phoneFromApi || phoneFromText;
    const phoneNormalized = normalizePhone(effectivePhone);

    // Жёсткие правила (без ИИ, бесплатно), два источника — свои для
    // каждого сайта:
    //  - OLX: если у продавца много других объявлений — агентство.
    //  - Uybor: сайт сам помечает аккаунт как организацию (не частник) —
    //    это ещё надёжнее числа объявлений.
    // Работает независимо от USE_AI_CLASSIFICATION.
    let sellerListingsCount = null;
    let isConfirmedAgent = false;
    let confirmedAgentReason = '';

    // Самая дешёвая проверка — бесплатная (без похода на страницу
    // профиля): продавец сам назвал себя риэлтором/агентством в имени
    // или подписи аватарки (см. sellerNameLooksLikeAgent в
    // fetchOlxDetails). Ставим её первой, до счётчика объявлений —
    // ловит агентов, у которых объявлений на OLX пока мало (только
    // начали), но кто уже не скрывает, что не частник.
    if (sellerNameLooksLikeAgent) {
      isConfirmedAgent = true;
      confirmedAgentReason = `имя/аватарка продавца ("${sellerName}") — риэлтор/агентство`;
    }

    // Проверка текста самого объявления на агентские слова
    // ("агентство", "риелтор", "комиссия" без "без комиссии" и т.п.,
    // см. agentSignals.js). Не зависит от сайта/вёрстки вообще —
    // работает даже если fetchDetails выше упал и остался только
    // заголовок (rawText = item.title по умолчанию).
    let textSignal = null;
    if (!isConfirmedAgent) {
      textSignal = findAgentTextSignal(rawText);
      if (textSignal) {
        isConfirmedAgent = true;
        confirmedAgentReason = `текст объявления содержит "${textSignal}"`;
      }
    }

    // Проверка "этот же номер телефона уже был на других
    // объявлениях" — тоже не зависит от сайта/вёрстки, работает по
    // своей же базе. Порог см. PHONE_REUSE_AGENT_THRESHOLD выше.
    let phoneReuseCount = 0;
    if (!isConfirmedAgent && phoneNormalized) {
      const phoneCacheKey = `${phoneNormalized}:${item.id}`;
      if (phoneCountCache.has(phoneCacheKey)) {
        phoneReuseCount = phoneCountCache.get(phoneCacheKey);
      } else {
        phoneReuseCount = await countListingsByPhone(phoneNormalized, item.id);
        phoneCountCache.set(phoneCacheKey, phoneReuseCount);
      }
      if (phoneReuseCount >= PHONE_REUSE_AGENT_THRESHOLD) {
        isConfirmedAgent = true;
        confirmedAgentReason = `тот же номер телефона уже на ${phoneReuseCount} других объявлениях`;
      }
    }

    // Не смогли ни одним способом посчитать число объявлений
    // продавца — либо реальный сбой сети/блокировки сайта (см.
    // detailsFetchFailed и историю с OLX 403 от 11.08.2026), либо OLX
    // поменял вёрстку. Раньше в этом случае ни одна проверка на
    // агента реально не срабатывала, а объявление всё равно уходило
    // с меткой "Скорее всего собственник" — из-за этого иногда
    // проскакивали продавцы с кучей объявлений: проверка молча не
    // отрабатывала, а не "честно проверила и не нашла agenтства".
    // Теперь такие случаи ниже (после isConfirmedOwner) не
    // отправляются вообще, а откладываются до следующего прогона.
    let sellerCheckUnavailable = false;

    if (!isConfirmedAgent && fetchSellerCount && sellerListingsUrl) {
      sellerListingsCount = await getCachedSellerCount(fetchSellerCount, sellerListingsUrl);
      if (sellerListingsCount !== null && sellerListingsCount > SELLER_LISTINGS_AGENT_THRESHOLD) {
        isConfirmedAgent = true;
        confirmedAgentReason = `${sellerListingsCount} объявлений`;
      } else if (sellerListingsCount === null) {
        // Основная проверка не удалась (страница профиля не открылась/
        // не распарсилась/заблокирована) — используем число со страницы
        // самого объявления как запасной, менее точный сигнал (может
        // включать не только недвижимость, поэтому берём порог с
        // запасом заметно выше основного).
        if (authorAdsCountHint !== null && authorAdsCountHint > SELLER_LISTINGS_AGENT_THRESHOLD * 2) {
          isConfirmedAgent = true;
          confirmedAgentReason = `~${authorAdsCountHint} объявлений (со страницы, точная проверка не удалась)`;
        } else if (authorAdsCountHint === null) {
          // И основная проверка не удалась, И запасного числа нет —
          // вообще ничего не смогли выяснить про продавца.
          sellerCheckUnavailable = true;
        }
      }
    } else if (fetchSellerCount && !sellerListingsUrl) {
      // Ссылку на профиль вообще не нашли (см. warn выше) — тот же
      // запасной сигнал, что и в ветке выше.
      if (authorAdsCountHint !== null && authorAdsCountHint > SELLER_LISTINGS_AGENT_THRESHOLD * 2) {
        isConfirmedAgent = true;
        confirmedAgentReason = `~${authorAdsCountHint} объявлений (со страницы, ссылка на профиль не найдена)`;
      } else if (!isConfirmedAgent && authorAdsCountHint === null) {
        sellerCheckUnavailable = true;
      }
    }
    if (!isConfirmedAgent && item.seller_is_organization) {
      isConfirmedAgent = true;
      confirmedAgentReason = 'аккаунт организации';
    }
    // Realting rent: страница объявления явно сказала "Агентство" —
    // такое же надёжное подтверждение, как organization-поле у Uybor.
    if (!isConfirmedAgent && item.source === 'realting' && item.realting_owner_confirmed === 'agent') {
      isConfirmedAgent = true;
      confirmedAgentReason = 'страница объявления Realting помечена "Агентство"';
    }
    if (isConfirmedAgent) {
      console.log(
        `[${sourceLabel}] продавец "${sellerName || '?'}" — похоже на агентство (${confirmedAgentReason}): ${item.title}`
      );
    }

    // Realting.uz сам размечает продавца. На fsbo-страницах продажи
    // сайт ГАРАНТИРУЕТ "от собственника" (realting_owner_confirmed
    // ставится true уже на этапе списка). На аренде подтверждение
    // приходит только со страницы объявления (см. выше) — если его
    // вообще нигде не нашли (ни true, ни 'agent'), НЕ считаем
    // собственником по умолчанию, а откладываем ниже через
    // sellerCheckUnavailable — как и для OLX при сбоях проверки.
    const isConfirmedOwner =
      !isConfirmedAgent && item.source === 'realting' && item.realting_owner_confirmed === true;
    if (
      !isConfirmedAgent &&
      !isConfirmedOwner &&
      item.source === 'realting' &&
      item.realting_owner_confirmed !== 'agent'
    ) {
      sellerCheckUnavailable = true;
    }

    if (!isConfirmedAgent && !isConfirmedOwner && sellerCheckUnavailable) {
      // Пропускаем ВЕСЬ этот прогон для объявления — не сохраняем и не
      // отправляем. isKnown() на следующем прогоне (через 15 минут)
      // снова увидит его как новое и попробует проверить продавца с
      // нуля. Пока OLX блокирует запросы (403), это означает, что
      // объявления с этого источника вообще перестанут приходить в
      // Telegram, пока блокировка не снимется/не будет починена — это
      // осознанный компромисс: лучше молчание, чем непроверенные
      // объявления с уверенной меткой "собственник".
      console.warn(
        `[${sourceLabel}] пропускаю — не удалось проверить продавца ни одним способом (сеть/блокировка/вёрстка сайта): ${item.url}`
      );
      continue;
    }

    let classification;
    let label;

    if (isConfirmedOwner) {
      classification = {
        seller_type: 'owner',
        confidence: 'high',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: 'Собственник (метка Realting.uz)', kind: 'owner' };
    } else if (isConfirmedAgent) {
      classification = {
        seller_type: 'agent',
        confidence: 'high',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: `Агентство (${confirmedAgentReason})`, kind: 'agent' };
    } else if (!USE_AI_CLASSIFICATION) {
      // Раньше эта ветка (без ИИ) писала "Без проверки ИИ" — но так как
      // явные агентства уже отсеиваются жёсткими правилами чуть выше
      // (isConfirmedAgent), то, что осталось непроверенным, почти всегда
      // и есть частник — так и подписываем, чтобы не пугать формулировкой
      // "не проверено".
      classification = {
        seller_type: 'unknown',
        confidence: 'n/a',
        district: null,
        rooms: null,
        area: null,
        phone: null,
      };
      label = { text: 'Скорее всего собственник', kind: 'unchecked' };
    } else {
      try {
        classification = await classifyListing(rawText, sellerName);
      } catch (err) {
        console.error('Ошибка классификации:', err.message);
        classification = {
          seller_type: 'unknown',
          confidence: 'low',
          district: null,
          rooms: null,
          area: null,
          phone: null,
        };
      }
      label = labelFor(classification);
    }

    // Нормализация района — нужна для фильтра в Telegram-боте
    // (иначе "Чиланзар"/"Chilonzor"/"Чиланзарский район" не совпадут
    // друг с другом). Приоритет источников (по явному решению):
    //  1. То, что продавец САМ написал в тексте объявления (заголовок
    //     + описание) — если он явно назвал район, это и есть самый
    //     достоверный источник, даже если структурное поле сайта
    //     говорит другое (JSON-поле показывает район ПУБЛИКАЦИИ
    //     объявления на сайте, а не обязательно тот, о котором пишет
    //     продавец, — бывают расхождения).
    //  2. Район от ИИ-классификации (если включена) — тоже читает
    //     текст объявления, тот же уровень доверия, что и п.1.
    //  3. Структурное поле с самого сайта (item.raw_district — сейчас
    //     JSON districtName у OLX, аналогичное поле у Uybor) —
    //     используется, только если продавец вообще не упомянул район
    //     в тексте.
    const district =
      normalizeDistrict(rawText) ||
      normalizeDistrict(classification.district) ||
      normalizeDistrict(item.raw_district);
    const districtRaw = classification.district || item.raw_district || null;

    // Числовая цена + валюта — нужны, чтобы бот мог фильтровать по
    // диапазону цены (price остаётся текстом для отображения как есть).
    const { value: priceValue, currency: priceCurrency } = listPrice;

    // Площадь/комнаты — раньше это давала ТОЛЬКО ИИ-классификация
    // (сейчас отключена, classification.rooms/area всегда null не
    // из-за бага, а по дизайну — см. ветки isConfirmedAgent/
    // isConfirmedOwner/!USE_AI_CLASSIFICATION выше). Регэксп-парсер
    // (listingDetails.js) — бесплатная замена, работает по тому же
    // rawText независимо от того, какая ветка классификации сработала.
    // Площадь/комнаты/этаж/состояние — через LLM (extractListingInfo,
    // Gemini), с автоматическим откатом на regex ВНУТРИ самой функции,
    // если LLM недоступна (см. extractListingInfo.js). Пауза после
    // вызова — чтобы не упереться в лимит бесплатного тира Gemini на
    // пачке новых объявлений за один прогон (сюда доходят только
    // новые — см. `if (await isKnown(item.id)) continue` в начале
    // цикла).
    // Агентские объявления (isConfirmedAgent) НЕ отправляются ни в
    // Telegram, ни на сайт по умолчанию (см. notifyToTopicGroup ниже и
    // client/api/listings.js: .neq('label_kind', 'agent')) — им не
    // нужны area_total/condition/legal_risk, которые даёт только ИИ.
    // Поэтому не тратим на них вызовы Gemini/Groq/... вообще (ни сам
    // запрос, ни паузу между вызовами) — сразу regex-only разбор,
    // площадь/комнаты он всё равно даёт (нужны для entityKey и
    // price_per_sqm, чтобы не плодить дублей в базе при повторных
    // прогонах).
    const llmInfo = isConfirmedAgent
      ? extractListingInfoRegexOnly(rawText)
      : await extractListingInfo(rawText);
    if (!isConfirmedAgent) {
      await sleep(isProviderActiveThisRun('gemini') ? LLM_EXTRACT_DELAY_MS : LLM_EXTRACT_DELAY_MS_NO_GEMINI);
    }

    // Для коммерции ("офис", "склад", "магазин" и т.п.) понятие
    // "комнаты" не имеет смысла — но regex/LLM-парсер работает по
    // тексту объявления вслепую и иногда всё равно цепляет число
    // (например путает "5 кабинетов"/"3 санузла" с комнатами), из-за
    // чего в карточке коммерческого объявления вылезает нелепое
    // "5-комн. Офис в аренду...". Обнуляем rooms сразу здесь, а не
    // точечно в каждом месте отображения (webhook/сайт/telegram.js) —
    // так гарантированно нет источника, откуда это число могло бы
    // просочиться повторно.
    const rooms = propertyType === 'commercial' ? null : (classification.rooms ?? llmInfo.rooms);
    const area = classification.area ?? llmInfo.area_living;

    // Сегмент (новостройка/вторичка) — LLM как последний фолбэк, если
    // ни структурное поле сайта, ни regex (detectMarketSegment на
    // строке 184) его не поймали.
    if (!marketSegment) marketSegment = llmInfo.market_segment;

    // Цена за м² — только когда есть и цена, и площадь; используется
    // детектором "ниже рынка" (см. marketStats.js).
    //
    // Санити-проверка ДОБАВЛЕНА 12.08.2026, ПОСЛЕ реального случая:
    // JSON-LD цена с OLX иногда даёт мусорное число ("5 у.е." на
    // аренде квартиры — см. фикс в fetchOlxDetails/isPlausiblePrice
    // выше), а Uzbek-латиница в тексте объявления может обмануть
    // regex площади (см. listingDetails.js) и подсунуть не то число.
    // Оба случая дают price_per_sqm, отличающуюся от реальной в СОТНИ
    // или ТЫСЯЧИ раз — а такую ошибку статистика (marketStats.js)
    // сама по себе распознать не может, она просто видит "очень
    // низкую цену" и радостно ставит below_market=true. Поэтому —
    // грубый, заведомо widе "не бывает такого" фильтр в USD-эквиваленте
    // (независимо от валюты объявления), ДО того, как значение вообще
    // попадёт в базу/статистику. Границы намеренно нестрогие — это не
    // попытка отсечь реальные дешёвые/дорогие варианты, а только явный
    // мусор на порядки off.
    const PRICE_PER_SQM_SANITY_USD = {
      sale: [50, 20000],
      rent: [0.5, 100],
    };
    function isPlausiblePricePerSqm(value, currency, deal) {
      if (!value || !currency) return false;
      const usd = toUsd({ value, currency }, EXCHANGE_RATE_USD_UZS);
      if (!usd) return false;
      const [min, max] = PRICE_PER_SQM_SANITY_USD[deal] || PRICE_PER_SQM_SANITY_USD.sale;
      return usd >= min && usd <= max;
    }

    const rawPricePerSqm =
      priceValue && area ? Math.round((priceValue / area) * 100) / 100 : null;
    const pricePerSqm =
      rawPricePerSqm && isPlausiblePricePerSqm(rawPricePerSqm, priceCurrency, dealType)
        ? rawPricePerSqm
        : null;

    // Срочность/торг из текста — не зависит от цены, отдельный сигнал
    // (см. urgencySignals.js). Полезен даже без below_market: часто
    // просто подсказывает, что с продавцом можно поторговаться.
    const urgencyPhrase = findUrgencySignal(rawText);

    const { belowMarket, belowMarketPct, sampleSize } = marketStatsMap
      ? evaluateDeal(marketStatsMap, {
          propertyType,
          dealType,
          district,
          currency: priceCurrency,
          pricePerSqm,
          marketSegment,
        })
      : { belowMarket: false, belowMarketPct: null, sampleSize: null };

    const sellerNameLooksLikePerson = looksLikePersonName(sellerName);
    const ownerScoreResult = computeOwnerScore({
      isConfirmedOwner,
      isConfirmedAgent,
      sellerListingsCount,
      phoneReuseCount,
      sellerNameLooksLikeAgent,
      textAgentSignal: textSignal,
      sellerIsOrganization: !!item.seller_is_organization,
      sellerName,
      sellerNameLooksLikePerson,
      source: item.source,
    });

    const entityKey = makeEntityKey({
      ...item,
      title: item.title,
      seller_name: sellerName,
      phone_normalized: phoneNormalized,
      district,
      rooms,
      area,
      price_value: priceValue,
      price_currency: priceCurrency,
      image_url: item.image_url,
    });

    const currentPriceUsd =
      priceValue && priceCurrency ? toUsd({ value: priceValue, currency: priceCurrency }, EXCHANGE_RATE_USD_UZS) : null;
    const previousForSameId = existingById && existingById.id === item.id ? existingById : null;
    const previousPriceUsd =
      previousForSameId?.price_value && previousForSameId?.price_currency
        ? toUsd(
            { value: previousForSameId.price_value, currency: previousForSameId.price_currency },
            EXCHANGE_RATE_USD_UZS
          )
        : null;
    const sameIdPriceChanged =
      isSignificantPriceChange(previousPriceUsd, currentPriceUsd) ||
      (previousForSameId && previousForSameId.price_value == null && priceValue != null);

    const priceHistorySummary = summarizePriceHistory(
      previousForSameId?.price_history,
      {
        observed_at: new Date().toISOString(),
        price_value: priceValue,
        price_currency: priceCurrency,
        price_text: item.price || null,
        price_per_sqm: pricePerSqm,
      },
      EXCHANGE_RATE_USD_UZS
    );

    const dealScoreResult = computeDealScore({
      belowMarketPct,
      marketSampleSize: sampleSize,
      ownerScore: ownerScoreResult.score,
      priceHistory: priceHistorySummary,
      urgencyPhrase,
    });

    const entityCacheKey = `${entityKey}:${item.id}`;
    const latestEntityListing =
      previousForSameId || entityLookupCache.get(entityCacheKey) || (await getLatestListingByEntityKey(entityKey, item.id));
    if (!previousForSameId && !entityLookupCache.has(entityCacheKey)) {
      entityLookupCache.set(entityCacheKey, latestEntityListing);
    }
    const latestEntityUsd =
      latestEntityListing?.price_value && latestEntityListing?.price_currency
        ? toUsd(
            { value: latestEntityListing.price_value, currency: latestEntityListing.price_currency },
            EXCHANGE_RATE_USD_UZS
          )
        : null;
    const sameEntityExists = !!latestEntityListing;
    const duplicateByEntity =
      !previousForSameId &&
      sameEntityExists &&
      !sameIdPriceChanged &&
      (isDuplicatePriceChange(latestEntityUsd, currentPriceUsd) || currentPriceUsd == null || latestEntityUsd == null);
    const shouldSendDeal = !isConfirmedAgent && !duplicateByEntity && shouldNotifyDealCandidate(dealScoreResult.score);
    const dealCandidate =
      shouldSendDeal &&
      (dealScoreResult.components.market >= DEAL_SCORE_MIN_MARKET_COMPONENT ||
        priceHistorySummary.dropCount >= 1 ||
        ownerScoreResult.score >= 80);

    const duplicateReason = duplicateByEntity
      ? latestEntityUsd && currentPriceUsd
        ? `тот же объект уже был в базе, цена изменилась менее чем на ${Number(process.env.DUPLICATE_PRICE_CHANGE_THRESHOLD_PCT) || 5}%`
        : 'тот же объект уже был в базе'
      : null;

    const listing = {
      ...item,
      raw_text: rawText,
      seller_name: sellerName,
      seller_listings_count: sellerListingsCount,
      district,
      district_raw: districtRaw,
      price_value: priceValue,
      price_currency: priceCurrency,
      price_per_sqm: pricePerSqm,
      below_market: belowMarket,
      below_market_pct: belowMarketPct,
      market_sample_size: sampleSize,
      market_segment: marketSegment,
      urgency_signal: !!urgencyPhrase,
      urgency_phrase: urgencyPhrase,
      entity_key: entityKey,
      is_duplicate: duplicateByEntity,
      duplicate_of_id: duplicateByEntity ? latestEntityListing.id : null,
      duplicate_reason: duplicateReason,
      deal_candidate: dealCandidate,
      deal_score: dealScoreResult.score,
      owner_score: ownerScoreResult.score,
      deal_score_breakdown: dealScoreResult.components,
      owner_score_breakdown: ownerScoreResult,
      price_history: priceHistorySummary.history,
      price_history_count: priceHistorySummary.count,
      price_drop_count: priceHistorySummary.dropCount,
      price_change_count: priceHistorySummary.changeCount,
      first_seen_price_value: previousForSameId?.first_seen_price_value ?? priceHistorySummary.firstSeenValue,
      last_seen_price_value: priceHistorySummary.lastSeenValue,
      last_price_change_pct: priceHistorySummary.lastChangePct,
      last_price_change_at: priceHistorySummary.lastObservedAt,
      last_seen_at: priceHistorySummary.lastObservedAt,
      rooms,
      area,
      phone: effectivePhone,
      phone_normalized: phoneNormalized,
      seller_type: classification.seller_type,
      confidence: classification.confidence,
      label_text: label.text,
      label_kind: label.kind,
      notified: false,
    };
    delete listing.phone_from_api; // служебное поле, в базу не пишем
    delete listing.phone_from_details; // тоже служебное — уже перенесено в phone
    delete listing.raw_district; // тоже служебное — уже перенесено в district/district_raw
    // 19.08.2026: item.realting_owner_confirmed (см. выше по файлу) —
    // тоже чисто служебное поле для определения владелец/агент внутри
    // этого прогона, в схеме Supabase такой колонки нет и не должно
    // быть. Без этого delete весь upsert падал на КАЖДОМ объявлении с
    // источника realting: "Could not find the 'realting_owner_confirmed'
    // column of 'listings' in the schema cache" — то есть ничего с
    // realting вообще не сохранялось и не уходило в Telegram.
    delete listing.realting_owner_confirmed;

    const saved = await saveListing(listing, existingById);
    if (!saved) {
      // Не сохранилось в базу — не шлём уведомление вообще (иначе
      // получим дубль на следующем прогоне, см. комментарий в db.js).
      // Просто пропускаем — при следующем запуске isKnown() снова
      // увидит его как "новое" и попробует сохранить+отправить с нуля.
      console.error(`[${sourceLabel}] пропускаю уведомление — не удалось сохранить в базу: ${listing.title}`);
      continue;
    }

    // 19.08.2026: БЫЛО — если объявление с этим же id уже есть в базе
    // и цена не менялась, считали, что оно уже отправлено, и просто
    // молча ставили notified=true без реальной отправки. Баг: если
    // ПРЕДЫДУЩИЙ прогон успел сохранить объявление (saveListing выше,
    // notified: false) но не успел дойти до notifyToTopicGroup —
    // прогон оборвался по timeout-minutes, упал с необработанной
    // ошибкой, или Telegram API не ответил (см. catch вокруг
    // notifyToTopicGroup ниже — он тоже НЕ ставит notified при сбое) —
    // то объявление молча помечалось отправленным и терялось навсегда,
    // ни разу реально не уйдя в Telegram. Теперь пропускаем повторную
    // отправку ТОЛЬКО если оно было ДЕЙСТВИТЕЛЬНО отправлено раньше
    // (previousForSameId.notified), а не просто "уже есть в базе".
    if (previousForSameId && !sameIdPriceChanged && previousForSameId.notified) {
      await markNotified(listing.id);
      continue;
    }

    if (listing.is_duplicate) {
      await markNotified(listing.id);
      console.log(`[${sourceLabel}] пропущен дубль (${listing.duplicate_reason || 'duplicate'}): ${listing.title}`);
      continue;
    }

    // Агентства (isConfirmedAgent) снова НЕ отправляем в Telegram —
    // вернули как было раньше (пробовали показывать всех, но по
    // фидбэку агентских объявлений слишком много и они мешают).
    // В базу (saveListing выше) пишем всех — чтобы не парсить их
    // заново на каждом прогоне, но notifyToTopicGroup зовём только для
    // тех, кто не агентство.
    if (isConfirmedAgent) {
      await markNotified(listing.id); // чтобы не пытались отправить его снова на будущих прогонах
      continue;
    }

    try {
      // Раньше тут ещё был notifyNewListing() — отправка ВСЕХ объявлений
      // (любого типа) в основной чат без привязки к теме. Убрали: он
      // приводил к тому, что в тему "General" супергруппы "Квартиры"
      // (это тот же чат, что и TELEGRAM_CHAT_ID) попадали вперемешку и
      // дома, и коммерция. notifyToTopicGroup сам по себе уже даёт
      // нужное: квартиры с известным районом уходят в свою тему, без
      // района — в "General" СВОЕЙ группы (но по-прежнему только
      // квартиры), а дома/коммерция — только в свои отдельные группы.
      const sentTo = await notifyToTopicGroup(listing);
      await markNotified(listing.id, sentTo);
      console.log(`[${sourceLabel}] уведомление отправлено (${label.kind}): ${listing.title}`);
    } catch (err) {
      console.error('Ошибка отправки в Telegram:', err.message);
    }

    // Отдельно, ДОПОЛНИТЕЛЬНО к обычной теме района — если объявление
    // "ниже рынка", дублируем его в отдельную супергруппу "Выгодные"
    // (тема по району внутри неё же). Специально не заменяем обычную
    // отправку выше: пользователь по-прежнему видит все объявления
    // своего района в привычном месте, а "Выгодные" — это фильтр
    // поверх, а не альтернативный канал.
    if (listing.deal_candidate) {
      try {
        await notifyDeal(listing);
      } catch (err) {
        console.error('Ошибка отправки в Telegram (тема "Выгодные"):', err.message);
      }
    }

    await new Promise((r) => setTimeout(r, 1200));
  }

  // Само-диагностика: если больше трети OLX-объявлений в этом прогоне
  // не дали найти ссылку на профиль продавца — это почти наверняка
  // значит, что OLX поменял вёрстку/текст кнопки, и жёсткое правило
  // "риэлтор по числу объявлений" массово не срабатывает. Раньше такая
  // поломка была не видна вообще никак, кроме как по жалобе через
  // несколько дней — теперь шлём алерт сразу, в этом же прогоне.
  // Порог (30%, минимум 5 проверенных) взят с запасом, чтобы не спамить
  // из-за пары случайных сбоев сети на конкретных страницах.
  if (sellerCheckedCount >= 5 && sellerLinkMissingCount / sellerCheckedCount > 0.3) {
    await notifyAlert(
      `⚠️ [${sourceLabel}] не найдена ссылка на профиль продавца у ${sellerLinkMissingCount} из ${sellerCheckedCount} объявлений. ` +
      `Похоже, OLX поменял вёрстку — проверка "риэлтор по числу объявлений" может массово не срабатывать. Нужно проверить scrapers/olx.js.`
    );
  }
}

// OLX: квартиры + дома + коммерция.
// Uybor: квартиры + дома + коммерция — category__eq ID подтверждены
// вживую 11.08.2026 через GET api.uybor.uz/api/v1/listings/categories
// (apartment=7, house=8, commercial=10), см. CATEGORY_BY_PROPERTY_TYPE
// в scrapers/uybor.js. Фильтр "только собственники" (detectAgentRole)
// общий для всех типов, отдельно на house/commercial настраивать не
// нужно.
// Realting: квартиры + дома + коммерция, продажа и аренда (для
// продажи используются готовые /fsbo-страницы сайта, для аренды —
// фильтрация по метке "Частный продавец" внутри scrapers/realting.js).
const OLX_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];
const UYBOR_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];
const REALTING_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];
const DOMTUT_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];
// Joymee: квартиры/дома/коммерция для ПРОДАЖИ И АРЕНДЫ — все 6
// комбинаций подтверждены вживую (11.08.2026, см. JOYMEE_CATEGORY в
// scrapers/joymee.js).
const JOYMEE_PROPERTY_TYPES = ['apartment', 'house', 'commercial'];

// 13.09.2026: разбивка прогона на 2 параллельных job'а в scrape.yml
// (matrix по dealType — sale/rent), т.к. даже после снижения
// LLM_EXTRACT_DELAY_MS одного job'а на всё (30 комбинаций
// source×propertyType×dealType подряд) может не хватать при большом
// числе новых объявлений. Намеренно делим ИМЕННО по dealType, а не по
// источнику: кросс-source дедуп (makeEntityKey — то же объявление,
// перевыложенное на разных сайтах) должен видеть уже сохранённые
// записи ДО следующего источника, а это гарантировано только внутри
// одного process, если он идёт строго последовательно. Деление по
// источникам создало бы гонку: два параллельных job'а могли бы не
// увидеть вставку друг друга и оба посчитать одно и то же объявление
// новым. Деление по dealType этого риска не несёт — sale и rent
// внутри каждого job'а по-прежнему обходятся строго последовательно.
// DEAL_TYPE_FILTER не задан (пусто/undefined) — старое поведение,
// обрабатываются оба типа сделки подряд в одном процессе (напр. для
// локального запуска или ручного workflow_dispatch без matrix).
const DEAL_TYPE_FILTER = process.env.DEAL_TYPE_FILTER || null;
const RUN_SALE = DEAL_TYPE_FILTER !== 'rent';
const RUN_RENT = DEAL_TYPE_FILTER !== 'sale';

async function main() {
  if (DEAL_TYPE_FILTER) {
    console.log(`Прогон ограничен DEAL_TYPE_FILTER=${DEAL_TYPE_FILTER}`);
  }

  // Пересчёт медиан цены за м² (если устарели/пусто) ДО обработки
  // объявлений этого прогона — см. marketStats.js. Затем сама таблица
  // грузится в память один раз (loadMarketStatsMap) и передаётся во
  // все processSource(), а не читается из базы на каждое объявление.
  // Безопасно дублировать в обоих параллельных job'ах (sale/rent) —
  // это идемпотентный upsert по group_key, без обращений к LLM.
  await refreshMarketStatsIfStale();
  const marketStatsMap = await loadMarketStatsMap();

  // Продажа — в приоритете, проверяем её первой в каждом цикле
  if (RUN_SALE) {
    for (const propertyType of OLX_PROPERTY_TYPES) {
      await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'sale', fetchOlxSellerListingsCount, propertyType, marketStatsMap);
      await olxDelay();
    }
    for (const propertyType of UYBOR_PROPERTY_TYPES) {
      await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'sale', null, propertyType, marketStatsMap);
    }
    if (REALTING_ENABLED) {
      for (const propertyType of REALTING_PROPERTY_TYPES) {
        await processSource(fetchRealtingListings, fetchRealtingDetails, 'realting', 'sale', null, propertyType, marketStatsMap);
      }
    }
    if (DOMTUT_ENABLED) {
      for (const propertyType of DOMTUT_PROPERTY_TYPES) {
        await processSource(fetchDomtutListings, fetchDomtutDetails, 'domtut', 'sale', null, propertyType, marketStatsMap);
      }
    }
    // Joymee: endpoint/поля подтверждены вживую 11.08.2026 (см. шапку
    // scrapers/joymee.js) — продажа квартир/домов/коммерции (все три
    // category/property_type подтверждены скриншотами DevTools). Фильтр
    // "только собственники" реализован через advertiser_type в
    // fetchJoymeeDetails (advertiser_type !== 1 → sellerNameLooksLikeAgent
    // → агентства не уходят в Telegram, см. processSource выше).
    for (const propertyType of JOYMEE_PROPERTY_TYPES) {
      await processSource(fetchJoymeeListings, fetchJoymeeDetails, 'joymee', 'sale', null, propertyType, marketStatsMap);
    }
  }

  if (RUN_RENT) {
    for (const propertyType of OLX_PROPERTY_TYPES) {
      await processSource(fetchOlxListings, fetchOlxDetails, 'olx', 'rent', fetchOlxSellerListingsCount, propertyType, marketStatsMap);
      await olxDelay();
    }
    for (const propertyType of UYBOR_PROPERTY_TYPES) {
      await processSource(fetchUyborListings, fetchUyborDetails, 'uybor', 'rent', null, propertyType, marketStatsMap);
    }
    if (REALTING_ENABLED) {
      for (const propertyType of REALTING_PROPERTY_TYPES) {
        await processSource(fetchRealtingListings, fetchRealtingDetails, 'realting', 'rent', null, propertyType, marketStatsMap);
      }
    }
    if (DOMTUT_ENABLED) {
      for (const propertyType of DOMTUT_PROPERTY_TYPES) {
        await processSource(fetchDomtutListings, fetchDomtutDetails, 'domtut', 'rent', null, propertyType, marketStatsMap);
      }
    }
    // Joymee-аренда: deal_type=2 подтверждён вживую 11.08.2026 (см.
    // JOYMEE_DEAL_TYPE в scrapers/joymee.js), квартиры/дом/коммерция для
    // аренды тоже все подтверждены (см. JOYMEE_CATEGORY.rent в
    // scrapers/joymee.js).
    for (const propertyType of JOYMEE_PROPERTY_TYPES) {
      await processSource(fetchJoymeeListings, fetchJoymeeDetails, 'joymee', 'rent', null, propertyType, marketStatsMap);
    }
  }
  console.log('Проверка завершена.');

  // Автоматическая чистка по расписанию: раз в 15 минут, вместе со
  // скрапингом. Удаляет только то, у чего уже есть сохранённый
  // telegram_chat_id/telegram_message_id (новые объявления, помеченные
  // агентом в этом же прогоне выше, или вручную кнопкой "Это агент" в
  // Telegram). Старый мусор без сохранённого id сюда не попадает — для
  // него нужен разовый backfill-from-telegram-export.js.
  // Выполняется ТОЛЬКО в job'е sale (не в rent и не когда фильтр не
  // задан вообще — тогда это единственный job, ему можно) — очередь
  // агентских сообщений общая для sale и rent (запрос не фильтрует по
  // dealType), и если оба параллельных job'а полезут удалять одни и те
  // же сообщения одновременно, второй словит ложный "не удалось
  // удалить" на том, что первый уже успешно удалил.
  if (!DEAL_TYPE_FILTER || DEAL_TYPE_FILTER === 'sale') {
    try {
      console.log('Автоочистка агентских сообщений...');
      const { totalCandidates, deleted, failed, withoutIdCount } = await cleanAgentBacklog({ quiet: true });
      if (totalCandidates > 0) {
        console.log(
          `Автоочистка: удалено ${deleted}, не удалось ${failed}, недостижимо (нет id) ${withoutIdCount} (из ${totalCandidates} кандидатов).`
        );
      } else {
        console.log('Автоочистка: чистить нечего.');
      }
    } catch (err) {
      console.error('Автоочистка агентских сообщений: ошибка:', err.message);
    }
  }
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});