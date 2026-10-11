import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { detectMarketSegment } from '../marketSegment.js';

// Разовый скрипт: market_segment (см. ../marketSegment.js) появился в проекте 15.08.2026 и заполняется
// заново только для объявлений, которые скрапер видит С ЭТОГО МОМЕНТА
// (см. run.js). У всех объявлений, накопленных ДО этого, поле
// market_segment = null — из-за этого сегментированная группировка
// (segmentedGroupKey) для них просто не работает, статистика по-прежнему
// считается по-старому (весь район одной кучей).
//
// Повторный поход на OLX/Uybor/Realting/Joymee для этого НЕ нужен —
// raw_text (title+description) уже сохранён в базе с первого раза,
// этого достаточно, чтобы прогнать по нему тот же regex-детектор
// задним числом.
//
// Берём только объявления, которые реально участвуют в расчёте
// статистики (price_per_sqm заполнен, label_kind не 'agent' — те же
// условия, что и в getStatsSourceListings в db.js) — нет смысла
// размечать то, что в статистику всё равно не попадает.
//
// Можно прерывать (Ctrl+C) и запускать повторно сколько угодно раз —
// безвредно: уже размеченные (market_segment не null) в выборку
// повторно не попадут (см. .is('market_segment', null) ниже).
//
// Запуск:
//   cd scraper
//   node src/scripts/backfill-market-segment.js

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

const PAGE_SIZE = 1000;
const CONCURRENCY = 10; // параллельных update-запросов к Supabase за раз

async function fetchCandidates() {
  let all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('listings')
      .select('id, raw_text')
      .is('market_segment', null)
      .not('price_per_sqm', 'is', null)
      .in('label_kind', ['owner', 'unchecked'])
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase: ${error.message}`);
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function main() {
  console.log('Ищу уже сохранённые объявления без определённого market_segment...');
  const candidates = await fetchCandidates();
  console.log(`Кандидатов на разметку: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log('Нечего обновлять — либо база пустая, либо всё уже размечено.');
    return;
  }

  let updated = 0;
  let noPhraseFound = 0;
  let errors = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const segment = detectMarketSegment(row.raw_text);
        if (!segment) {
          // Явной фразы в сохранённом тексте нет — оставляем null, как
          // и было. Это ожидаемо для большинства старых объявлений
          // (детектор строгий, см. пояснение в marketSegment.js) —
          // ничего не ломает, они просто продолжат участвовать только
          // в несегментированной группе района, как раньше.
          noPhraseFound++;
          return;
        }
        const { error } = await supabase.from('listings').update({ market_segment: segment }).eq('id', row.id);
        if (error) {
          errors++;
          console.error(`Ошибка обновления ${row.id}:`, error.message);
        } else {
          updated++;
        }
      })
    );
    console.log(`Обработано ${Math.min(i + CONCURRENCY, candidates.length)}/${candidates.length}...`);
  }

  console.log(
    `\nГотово. Проставлен сегмент: ${updated}. Явной фразы не нашлось: ${noPhraseFound}. Ошибок: ${errors}.`
  );
}

main().catch((err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
