// Ссылка «найти на карте» по адресу/ориентиру из текста объявления.
// Формат Google Maps URLs (api=1&query=…) задокументирован и не требует API-ключа:
// https://developers.google.com/maps/documentation/urls/guide
export function mapSearchUrl(query) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (q.length < 3) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
