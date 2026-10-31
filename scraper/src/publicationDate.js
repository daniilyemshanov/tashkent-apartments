const UNKNOWN_DATE = /^(?:неизвестно|unknown|n\/?a|[-—])$/i;
const TASHKENT_OFFSET = '+05:00';

function tashkentDateParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function makeTashkentDate(year, month, day, hour = 0, minute = 0, second = 0) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const value = new Date(`${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${TASHKENT_OFFSET}`);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

export function parsePublishedAt(rawValue, now = new Date()) {
  if (rawValue == null) return null;
  const raw = String(rawValue).trim();
  if (!raw || UNKNOWN_DATE.test(raw)) return null;

  // ISO timestamps from APIs and unambiguous ISO calendar dates.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (iso) {
    const [year, month, day, hour = '0', minute = '0', second = '0', zone = ''] = iso.slice(1);
    const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (probe.getUTCFullYear() !== Number(year) || probe.getUTCMonth() + 1 !== Number(month) || probe.getUTCDate() !== Number(day)) return null;
    if (zone) {
      const value = new Date(raw);
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    return makeTashkentDate(year, month, day, Number(hour), Number(minute), Number(second));
  }

  // Unambiguous Uzbekistan-style date: DD.MM.YYYY, optionally with local time.
  const local = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (local) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = local;
    const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (probe.getUTCFullYear() !== Number(year) || probe.getUTCMonth() + 1 !== Number(month) || probe.getUTCDate() !== Number(day)) return null;
    return makeTashkentDate(year, month, day, Number(hour), Number(minute), Number(second));
  }

  const parts = tashkentDateParts(now);
  const dayStamp = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const localDate = (daysAgo, hour = 0, minute = 0) => {
    const shifted = new Date(dayStamp - daysAgo * 24 * 60 * 60 * 1000);
    return makeTashkentDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), hour, minute);
  };
  const lower = raw.toLocaleLowerCase();
  const relativeDay = lower.match(/^(сегодня|bugun|today|вчера|kecha|yesterday)(?:\s+(?:в\s*)?(\d{1,2}):(\d{2}))?$/i);
  if (relativeDay) {
    const word = relativeDay[1];
    const daysAgo = /^(вчера|kecha|yesterday)$/i.test(word) ? 1 : 0;
    return localDate(daysAgo, Number(relativeDay[2] || 0), Number(relativeDay[3] || 0));
  }

  const relative = lower.match(/^(\d+)\s*(?:день|дня|дней|дн|kun)\s*(?:назад|oldin)$/i);
  if (relative) {
    const days = Number(relative[1]);
    if (days <= 0 || days > 3650) return null;
    return localDate(days);
  }
  return null;
}
