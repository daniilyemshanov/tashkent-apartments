// Разбирает уже готовую текстовую цену объявления (как её вернул
// скрапер, например "800 315 000 сум", "45 000 $", "500 у.е.") в
// число + валюту — нужно, чтобы фильтр по цене в Telegram-боте мог
// сравнивать цены между собой, а не просто хранить их как текст.
//
// ВАЖНО: копия этой логики есть в client/api/_priceParser.js (парсит
// произвольный ввод пользователя вида "300-800 млн", а не готовую
// строку цены объявления) — они решают разные задачи, но используют
// одну и ту же логику определения валюты. Если меняете эвристику
// определения валюты — проверьте оба файла.

// "у.е." — кириллицей это пишет OLX. Но Joymee отдаёт то же самое
// значение (currency_display в их API) ЛАТИНИЦЕЙ — "y.e." — визуально
// неотличимо от кириллического "у.е.", но для regex это два разных
// символа. Раньше сюда попадал только кириллический вариант, поэтому
// ВСЕ цены с Joymee в формате "y.e." не распознавались как USD и
// проваливались в fallback-эвристику ниже (currency = value < 100000
// ? 'USD' : 'UZS') — а суммы вида "110000 y.e." (то есть $110 000)
// почти всегда попадали в ветку 'UZS', занижая price_per_sqm в ~12000
// раз и давая абсурдные "100% ниже рынка". Обнаружено 12.08.2026 —
// см. обсуждение в чате. Теперь ловим оба алфавита сразу.
const USD_MARKERS = /\$|[yу]\.?\s?[eе]\.?|\busd\b/i;
const UZS_MARKERS = /сум|so'?m|\buzs\b/i;

/**
 * @param {string} rawPrice текст цены, как есть у скрапера
 * @returns {{ value: number|null, currency: 'USD'|'UZS'|null }}
 */
export function parsePrice(rawPrice) {
  if (!rawPrice) return { value: null, currency: null };

  const text = String(rawPrice);
  const digits = text.match(/\d+/g);
  if (!digits || digits.length === 0) return { value: null, currency: null };

  const value = Number(digits.join(''));
  if (!Number.isFinite(value) || value <= 0) return { value: null, currency: null };

  let currency = null;
  if (USD_MARKERS.test(text)) currency = 'USD';
  else if (UZS_MARKERS.test(text)) currency = 'UZS';
  else {
    // Валюта не указана явно (редко, но бывает) — определяем по
    // порядку величины: суммы в сумах на рынке Ташкента почти всегда
    // 6+ значные (сотни млн/млрд), суммы в у.е./$ — обычно до 6 знаков.
    // Эвристика приблизительная, работает как fallback.
    currency = value < 100000 ? 'USD' : 'UZS';
  }

  return { value, currency };
}

/**
 * Переводит цену в сумы для сравнения "яблок с яблоками" при фильтрации.
 * Курс — ПРИБЛИЗИТЕЛЬНЫЙ, задаётся через .env (EXCHANGE_RATE_USD_UZS),
 * т.к. у скрапера нет доступа к живому курсу ЦБ. Стоит время от
 * времени сверять с реальным курсом и обновлять .env.
 */
export function toUzs({ value, currency }, exchangeRateUsdUzs) {
  if (value === null) return null;
  if (currency === 'USD') return value * exchangeRateUsdUzs;
  return value;
}

/**
 * Обратная конвертация — в доллары. Нужна для сравнения цен: объявления
 * на одном и том же рынке продавцы
 * выставляют то в $, то в сумах, и раньше это давало ДВЕ раздельные
 * группы (apartment|sale|Чиланзар|USD и apartment|sale|Чиланзар|UZS)
 * вместо одной — выборка искусственно делилась пополам, медиана
 * дольше становилась надёжной. Приводим всё к USD ТОЛЬКО для расчёта
 * статистики; исходная валюта объявления в базе не меняется.
 */
export function toUsd({ value, currency }, exchangeRateUsdUzs) {
  if (value === null) return null;
  if (currency === 'UZS') return value / exchangeRateUsdUzs;
  return value;
}
