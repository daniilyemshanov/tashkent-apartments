import crypto from 'node:crypto';
import { toUsd } from './priceParser.js';

const DEFAULT_SIGNIFICANT_PRICE_CHANGE_PCT = Number(process.env.DEAL_SCORE_SIGNIFICANT_PRICE_CHANGE_PCT) || 7;
const DEFAULT_DUPLICATE_PRICE_CHANGE_PCT = Number(process.env.DUPLICATE_PRICE_CHANGE_THRESHOLD_PCT) || 5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

function observationToUsd(observation, exchangeRateUsdUzs) {
  if (!observation?.price_value || !observation?.price_currency) return null;
  return toUsd(
    { value: observation.price_value, currency: observation.price_currency },
    exchangeRateUsdUzs
  );
}

export function makeEntityKey(listing) {
  // Приоритет: телефон — единственный признак, который реально
  // связывает одно и то же объявление между РАЗНЫМИ источниками
  // (OLX/Uybor/Domtut/Realting) — сам объект недвижимости продают
  // по одному номеру, а URL у каждого сайта свой. НЕ включает
  // price_value/price_currency — текущая цена не идентификатор
  // объекта, объявление остаётся тем же самым объектом и после
  // изменения цены (иначе ломается история цены и защита от
  // повторной отправки — см. аудит от 19.08.2026).
  const phone = listing.phone_normalized || listing.phoneNormalized || null;
  if (phone) return `phone:${phone}`;

  const url = listing.url ? normalizeText(listing.url) : null;
  if (url) return `url:${url}`;

  const image = listing.image_url ? normalizeText(listing.image_url) : '';
  const base = [
    listing.source,
    listing.deal_type,
    listing.property_type,
    listing.district,
    listing.rooms,
    listing.area,
    listing.title,
    listing.seller_name,
    image,
  ]
    .map(normalizeText)
    .join('|');
  return `text:${hash(base)}`;
}

export function summarizePriceHistory(previousHistory, currentObservation, exchangeRateUsdUzs) {
  const history = Array.isArray(previousHistory)
    ? [...previousHistory]
    : typeof previousHistory === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(previousHistory);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  const normalizedCurrent = {
    observed_at: currentObservation.observed_at || new Date().toISOString(),
    price_value: currentObservation.price_value ?? null,
    price_currency: currentObservation.price_currency ?? null,
    price_text: currentObservation.price_text ?? null,
    price_per_sqm: currentObservation.price_per_sqm ?? null,
  };

  const last = history[history.length - 1];
  const sameAsLast =
    last &&
    String(last.price_value ?? '') === String(normalizedCurrent.price_value ?? '') &&
    String(last.price_currency ?? '') === String(normalizedCurrent.price_currency ?? '') &&
    String(last.price_text ?? '') === String(normalizedCurrent.price_text ?? '');

  if (!sameAsLast) {
    history.push(normalizedCurrent);
  }

  const observations = history
    .map((entry) => ({
      observed_at: entry.observed_at || new Date().toISOString(),
      price_value: entry.price_value ?? null,
      price_currency: entry.price_currency ?? null,
      price_text: entry.price_text ?? null,
      price_per_sqm: entry.price_per_sqm ?? null,
    }))
    .filter((entry) => entry.price_value != null && entry.price_currency);

  const first = observations[0] || normalizedCurrent;
  const previous = observations[observations.length - 2] || null;
  const current = observations[observations.length - 1] || normalizedCurrent;
  const firstUsd = observationToUsd(first, exchangeRateUsdUzs);
  const previousUsd = previous ? observationToUsd(previous, exchangeRateUsdUzs) : null;
  const currentUsd = observationToUsd(current, exchangeRateUsdUzs);

  const lastChangePct =
    previousUsd && currentUsd && previousUsd > 0
      ? round1(((currentUsd - previousUsd) / previousUsd) * 100)
      : null;
  const totalChangePct =
    firstUsd && currentUsd && firstUsd > 0 ? round1(((currentUsd - firstUsd) / firstUsd) * 100) : null;
  const dropCount = observations.reduce((acc, entry, index) => {
    if (index === 0) return acc;
    const prev = observations[index - 1];
    const prevUsd = observationToUsd(prev, exchangeRateUsdUzs);
    const currUsd = observationToUsd(entry, exchangeRateUsdUzs);
    return acc + (prevUsd != null && currUsd != null && currUsd < prevUsd ? 1 : 0);
  }, 0);

  return {
    history,
    count: history.length,
    dropCount,
    changeCount: Math.max(0, history.length - 1),
    firstSeenValue: first.price_value ?? null,
    firstSeenCurrency: first.price_currency ?? null,
    lastSeenValue: current.price_value ?? null,
    lastSeenCurrency: current.price_currency ?? null,
    lastChangePct,
    totalChangePct,
    lastObservedAt: current.observed_at || new Date().toISOString(),
    changed: !sameAsLast,
  };
}

export function computeOwnerScore({
  isConfirmedOwner = false,
  isConfirmedAgent = false,
  sellerListingsCount = null,
  phoneReuseCount = 0,
  sellerNameLooksLikeAgent = false,
  textAgentSignal = null,
  sellerIsOrganization = false,
  sellerName = null,
  sellerNameLooksLikePerson = false,
  source = null,
}) {
  if (isConfirmedAgent) {
    return {
      score: 5,
      reason: 'Сайт/правила уже указывают на агентство',
      signals: ['confirmed_agent'],
    };
  }
  if (isConfirmedOwner) {
    return {
      score: 95,
      reason: 'Сайт явно указывает на собственника',
      signals: ['confirmed_owner'],
    };
  }

  let score = 60;
  const signals = [];

  if (sellerIsOrganization) {
    score -= 25;
    signals.push('organization');
  } else {
    score += 8;
  }

  if (sellerNameLooksLikeAgent) {
    score -= 20;
    signals.push('agent_name');
  } else if (sellerNameLooksLikePerson) {
    score += 6;
    signals.push('person_name');
  }

  if (textAgentSignal) {
    score -= 22;
    signals.push(`text:${textAgentSignal}`);
  } else {
    score += 6;
  }

  if (typeof sellerListingsCount === 'number') {
    if (sellerListingsCount >= 10) {
      score -= 22;
      signals.push('many_listings');
    } else if (sellerListingsCount >= 4) {
      score -= 15;
      signals.push('several_listings');
    } else if (sellerListingsCount <= 1) {
      score += 8;
      signals.push('few_listings');
    }
  }

  if (phoneReuseCount >= 8) {
    score -= 28;
    signals.push('phone_heavily_reused');
  } else if (phoneReuseCount >= 3) {
    score -= 18;
    signals.push('phone_reused');
  } else if (phoneReuseCount === 0) {
    score += 4;
    signals.push('phone_unique');
  }

  if (sellerName && /без\s+комис/i.test(String(sellerName).toLowerCase())) {
    score += 5;
    signals.push('no_commission');
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    reason:
      signals.includes('confirmed_owner')
        ? 'Сайт явно указывает на собственника'
        : signals.includes('confirmed_agent')
          ? 'Сайт/правила уже указывают на агентство'
          : 'Скомбинированы признаки по телефону, тексту и типу продавца',
    signals,
    source,
  };
}

export function isSignificantPriceChange(previousUsd, currentUsd) {
  if (!previousUsd || !currentUsd || previousUsd <= 0) return false;
  const pct = Math.abs(((currentUsd - previousUsd) / previousUsd) * 100);
  return pct >= DEFAULT_SIGNIFICANT_PRICE_CHANGE_PCT;
}

export function isDuplicatePriceChange(previousUsd, currentUsd) {
  if (!previousUsd || !currentUsd || previousUsd <= 0) return false;
  const pct = Math.abs(((currentUsd - previousUsd) / previousUsd) * 100);
  return pct < DEFAULT_DUPLICATE_PRICE_CHANGE_PCT;
}
