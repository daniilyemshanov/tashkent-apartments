// Проверка: есть ли на странице объявления координаты и в каком виде.
//   cd scraper && node src/check-coords.js "https://www.olx.uz/d/obyavlenie/....html"
// Покажет найденную точку и фрагменты страницы со словами lat/lon/map/address —
// по ним можно подстроить извлечение (geoCoords.js), если формат окажется другим.

import { getWithRetry } from './http.js';
import { extractCoordsFromHtml } from './geoCoords.js';

const url = process.argv[2];
if (!url) {
  console.error('Использование: node src/check-coords.js <ссылка на объявление>');
  process.exit(1);
}

const res = await getWithRetry(url, {
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Accept-Language': 'ru-RU,ru;q=0.9' },
}, 3, url.includes('olx.') );
const html = String(res.data);
console.log(`Страница получена: ${html.length} символов\n`);

const found = extractCoordsFromHtml(html);
console.log(found ? `✅ Координаты найдены: ${JSON.stringify(found)}\n   Проверьте на карте: https://www.google.com/maps/search/?api=1&query=${found.lat},${found.lng}` : '❌ Координаты не найдены по известным шаблонам');

const snippets = (re, label) => {
  const list = [...html.matchAll(re)].slice(0, 5).map((m) => m[0].replace(/\s+/g, ' ').slice(0, 200));
  console.log(`\n[${label}] совпадений: ${list.length}`);
  list.forEach((s) => console.log('  ' + s));
};
snippets(/.{0,60}"(?:lat|latitude|lon|lng|longitude)"\s*:.{0,100}/g, 'lat/lon');
snippets(/.{0,40}"map"\s*:.{0,160}/g, 'map');
snippets(/.{0,40}"(?:address|street|streetName)"\s*:.{0,120}/g, 'address');
snippets(/(?:maps\.google|yandex\.[a-z]+\/maps|2gis\.)[^"'\s<]{0,120}/g, 'ссылки на карты');
