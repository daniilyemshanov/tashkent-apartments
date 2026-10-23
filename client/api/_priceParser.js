// Разбирает произвольный текстовый ввод цены от пользователя в
// Telegram-боте (в ответ на вопрос "укажите диапазон цены"), напр.:
//   "300-800"        -> 300..800, единицы и валюта определяются эвристикой
//   "300-800 млн"     -> умножает оба числа на 1 000 000
//   "1-2 млрд"        -> умножает на 1 000 000 000
//   "от 500 $"        -> min=500, max=null, currency=USD
//   "до 1500 у.е."    -> min=null, max=1500, currency=USD
//   "500-1500$"       -> currency=USD
// Возвращает null, если ничего похожего на число не нашлось — тогда
// бот должен попросить переформулировать.
//
// Логика валюты дублирует scraper/src/priceParser.js (для готовых
// цен объявлений) — см. комментарий там про необходимость менять оба
// файла синхронно, если правите эвристику.

// См. scraper/src/priceParser.js — та же правка от 12.08.2026:
// ловим и кириллическое "у.е.", и латинское "y.e." (так его отдаёт
// Joymee), иначе цены с Joymee молча уезжали в UZS вместо USD.
const USD_MARKERS = /\$|[yу]\.?\s?[eе]\.?|\busd\b/i;
const UZS_MARKERS = /сум|so'?m|\buzs\b/i;
const BILLION = /млрд|billion|bln/i;
const MILLION = /млн|million|mln/i;
const THOUSAND = /тыс|thousand|\bk\b/i;

function multiplierFor(text) {
  if (BILLION.test(text)) return 1e9;
  if (MILLION.test(text)) return 1e6;
  if (THOUSAND.test(text)) return 1e3;
  return 1;
}

function detectCurrency(text, sampleValue) {
  if (USD_MARKERS.test(text)) return 'USD';
  if (UZS_MARKERS.test(text)) return 'UZS';
  // Без явной пометки — та же эвристика, что и у скрапера: небольшие
  // числа обычно означают $/у.е., крупные — сум.
  return sampleValue !== null && sampleValue < 100000 ? 'USD' : 'UZS';
}

/**
 * @param {string} text ввод пользователя
 * @returns {{min: number|null, max: number|null, currency: 'USD'|'UZS'}|null}
 */
export function parsePriceRange(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const mult = multiplierFor(raw);

  // Диапазон "X-Y" / "X – Y" / "X до Y"
  const rangeMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:-|–|—|до)\s*(\d+(?:[.,]\d+)?)/i);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1].replace(',', '.')) * mult;
    const max = parseFloat(rangeMatch[2].replace(',', '.')) * mult;
    return { min, max, currency: detectCurrency(raw, min) };
  }

  // "от X"
  const fromMatch = raw.match(/от\s*(\d+(?:[.,]\d+)?)/i);
  if (fromMatch) {
    const min = parseFloat(fromMatch[1].replace(',', '.')) * mult;
    return { min, max: null, currency: detectCurrency(raw, min) };
  }

  // "до X"
  const toMatch = raw.match(/до\s*(\d+(?:[.,]\d+)?)/i);
  if (toMatch) {
    const max = parseFloat(toMatch[1].replace(',', '.')) * mult;
    return { min: null, max, currency: detectCurrency(raw, max) };
  }

  // Одно число без "от"/"до" — считаем верхней границей ("в пределах X").
  const singleMatch = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (singleMatch) {
    const max = parseFloat(singleMatch[1].replace(',', '.')) * mult;
    return { min: null, max, currency: detectCurrency(raw, max) };
  }

  return null;
}

/** Указал ли человек валюту явно ($, у.е., usd, сум, млн/млрд) — иначе валюта угадана по величине числа. */
export function hasExplicitCurrency(text) {
  const raw = String(text || '');
  return USD_MARKERS.test(raw) || UZS_MARKERS.test(raw) || BILLION.test(raw) || MILLION.test(raw);
}
