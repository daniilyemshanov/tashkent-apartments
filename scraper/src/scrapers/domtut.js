import { extractParamsFromHtml, extractImageUrlsFromHtml } from '../postFormat.js';
import * as cheerio from 'cheerio';
import { getWithRetry } from '../http.js';
import { detectMarketSegment } from '../marketSegment.js';
import { findAgentTextSignal } from '../agentSignals.js';

const DOMTUT_ENABLED = process.env.DOMTUT_ENABLED !== 'false';
const DOMTUT_BASE = 'https://domtut.uz';
const MAX_PAGES = 3;

const DOMTUT_CATEGORIES = {
  apartment: {
    sale: [
      'https://domtut.uz/uz/filter/search?form=resale',
      'https://domtut.uz/uz/filter/search?form=building',
    ],
    rent: [
      'https://domtut.uz/uz/filter/search?format=rent&object=apartment',
      'https://domtut.uz/filter/search?format=rent&object=apartment',
    ],
  },
  house: {
    sale: [
      'https://domtut.uz/uz/filter/house',
      'https://domtut.uz/filter/house',
    ],
    rent: [
      'https://domtut.uz/uz/filter/search?format=rent&object=house',
      'https://domtut.uz/filter/search?format=rent&object=house',
    ],
  },
  commercial: {
    sale: [
      'https://domtut.uz/uz/filter/search?object=commercial',
      'https://domtut.uz/filter/search?object=commercial',
    ],
    rent: [
      'https://domtut.uz/uz/filter/search?format=rent&object=commercial',
      'https://domtut.uz/filter/search?format=rent&object=commercial',
    ],
  },
};

const PRICE_RE = /\d{1,3}(?:[\s\u00A0]\d{3})*\s*(?:сум|soʻm|so'm|usd|\$|у\.?\s?е\.?)/i;
const DISTRICT_RE = /(Алмазарский|Бектемирский|Чиланзарский|Мирабадский|Мирзо[-\s]?Улугбекский|Яккасарайский|Яшнабадский|Юнусабадский|Сергелийский|Шайхонтохурский|Ташкентский|Olmazor|Bektemir|Chilonzor|Mirobod|Mirzo Ulug'?bek|Yakkasaroy|Yashnobod|Yunusobod|Sergeli|Shayxontohur)/i;
const LISTING_LINK_RE = /\/nedvizhimost\/[^"'?#\s]+/i;

// Domtut, в отличие от Realting/Uybor, НЕ размечает продавца как
// "частник"/"агентство" сам — сайт в основном про новостройки от
// застройщиков (см. разведку конкурентов в истории проекта), а
// объявление от частного лица там скорее исключение. Раз готового
// поля нет, определяем организацию/агентство по явным признакам в
// тексте самой страницы объявления (см. fetchDomtutDetails):
//  - слово "Застройщик"/"Quruvchi"/"Ishlab chiquvchi" — застройщик
//    прямым текстом называет себя так, частник этого не пишет;
//  - организационно-правовая форма в названии продавца (ООО/MCHJ/
//    ЧП/АО/ОАО/ХК и т.п.) — тоже однозначный признак юрлица;
// Отдельно от этого run.js всё равно прогоняет generic-проверку
// findAgentTextSignal() по названию+описанию для ВСЕХ источников
// (риэлтор/агентство/брокер/"наша компания" и т.п.) — тут не
// дублируем её целиком, а используем ту же функцию только чтобы
// решить sellerNameLooksLikeAgent для Owner Score (см. ниже).
const DEVELOPER_RE = /Застройщик|Quruvchi|Ishlab\s+chiquvchi/i;
const LEGAL_ENTITY_RE = /\b(?:ООО|MCHJ|ЧП|XK|ХК|АО|ОАО|ЧЖ|QK|ЙИТИ|ИЧП)\b/i;

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return `${DOMTUT_BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

function pickRoutes(dealType, propertyType) {
  return DOMTUT_CATEGORIES[propertyType]?.[dealType] || [];
}

function extractTitle(link, $) {
  const clone = link.clone();
  clone.find('style, script').remove();
  let title = clone.text().trim();
  if (!title) title = link.find('img').attr('alt')?.trim() || '';
  if (!title) title = link.attr('aria-label')?.trim() || '';
  return title;
}

function extractCardData($, link) {
  let price = '';
  let district = null;
  let container = link.parent();
  for (let i = 0; i < 6 && container.length; i++) {
    const text = container.text();
    if (!price) {
      const match = text.match(PRICE_RE);
      if (match) price = match[0].trim();
    }
    if (!district) {
      const districtMatch = text.match(DISTRICT_RE);
      if (districtMatch) district = districtMatch[0];
    }
    if (price && district) break;
    container = container.parent();
  }
  return { price, district };
}

export async function fetchDomtutListings(dealType = 'sale', propertyType = 'apartment') {
  if (!DOMTUT_ENABLED) return [];

  const urls = pickRoutes(dealType, propertyType);
  if (!urls.length) return [];

  const seen = new Map();

  for (const route of urls) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? route : `${route}${route.includes('?') ? '&' : '?'}page=${page}`;
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
          2,
          false
        );
        html = res.data;
      } catch (err) {
        if (page === 1) {
          console.warn(`[domtut-${propertyType}-${dealType}] не удалось открыть ${url}: ${err.message}`);
        }
        break;
      }

      const $ = cheerio.load(html);
      const candidates = $('a[href]')
        .filter((_, el) => {
          const href = $(el).attr('href') || '';
          return LISTING_LINK_RE.test(href);
        })
        .toArray();

      if (page === 1) {
        console.log(
          `[domtut-${propertyType}-${dealType}] диагностика: html=${html.length} байт, найдено ссылок-кандидатов=${candidates.length}, title="${$('title').text().trim().slice(0, 80)}"`
        );
      }

      if (candidates.length === 0) {
        if (page === 1) {
          console.warn(`[domtut-${propertyType}-${dealType}] на странице 1 не нашлось ссылок на объявления`);
        }
        break;
      }

      let foundNewOnThisPage = false;
      for (const el of candidates) {
        const link = $(el);
        const href = link.attr('href') || '';
        const fullUrl = absUrl(href.split('?')[0]);
        const externalId = href.split('/').filter(Boolean).pop() || null;
        if (!fullUrl || !externalId || seen.has(externalId)) continue;

        const title = extractTitle(link, $);
        if (!title) continue;

        const { price, district } = extractCardData($, link);
        foundNewOnThisPage = true;

        seen.set(externalId, {
          id: `domtut_${externalId}`,
          source: 'domtut',
          deal_type: dealType,
          property_type: propertyType,
          url: fullUrl,
          title,
          price,
          posted_raw: 'неизвестно',
          seller_is_organization: false,
          market_segment: detectMarketSegment(title) || 'new_build',
          raw_district: district,
        });
      }

      if (!foundNewOnThisPage && page > 1) break;
    }
  }

  return Array.from(seen.values());
}

export async function fetchDomtutDetails(url) {
  try {
    const { data: html } = await getWithRetry(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 15000,
      },
      2,
      false
    );
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || '';
    const description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('article').text().replace(/\s+/g, ' ').trim().slice(0, 4000) ||
      $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);
    const rawText = `${title}\n${description}`.trim();
    const sellerName =
      /(?:Застройщик|Quruvchi|Ishlab chiquvchi)\s+([^\n|]+)/i.exec(rawText)?.[1]?.trim() || null;
    const isOrganization = Boolean(
      DEVELOPER_RE.test(rawText) || LEGAL_ENTITY_RE.test(rawText) || findAgentTextSignal(rawText)
    );
    // 21.08.2026: Domtut был единственным из 4 источников, у которого
    // вообще не извлекалась картинка (og:image) — все объявления
    // Domtut уходили в Telegram без image_url, а значит теперь (см.
    // sendListingCard в telegram.js) всегда падают в текстовый
    // фоллбэк, даже когда у объявления реально есть фото на сайте.
    const imageUrl = $('meta[property="og:image"]').attr('content') || null;
    const imageUrls = extractImageUrlsFromHtml($);
    return {
      description,
      sellerName,
      sellerListingsUrl: null,
      sellerIsOrganization: isOrganization,
      sellerNameLooksLikeAgent: isOrganization,
      imageUrl,
      imageUrls,
      paramsText: extractParamsFromHtml($),
      marketSegment: detectMarketSegment(rawText) || 'new_build',
    };
  } catch (err) {
    console.warn(`[domtut] не удалось получить детали ${url}: ${err.message}`);
    return {
      description: '',
      sellerName: null,
      sellerListingsUrl: null,
      sellerIsOrganization: false,
      sellerNameLooksLikeAgent: false,
      imageUrl: null,
      marketSegment: 'new_build',
    };
  }
}