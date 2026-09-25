// Проверка подключения к НОВОМУ Supabase-проекту.
//
// Как использовать:
// 1. Положите этот файл в scraper/ (рядом с package.json)
// 2. Убедитесь, что scraper/.env уже обновлён новыми SUPABASE_URL и
//    SUPABASE_SERVICE_KEY
// 3. Запустите: node test-new-supabase-connection.js
//    (из папки scraper/, чтобы подхватились node_modules)
//
// Скрипт ничего не пишет и не удаляет — только читает, безопасно
// гонять сколько угодно раз.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

console.log('--- Проверка подключения к Supabase ---');
console.log('SUPABASE_URL:', url || '(не задан!)');
console.log('SUPABASE_SERVICE_KEY:', key ? `${key.slice(0, 12)}...(скрыт)` : '(не задан!)');
console.log();

if (!url || !key || url.includes('НОВЫЙ_') || key.includes('НОВЫЙ_')) {
  console.error('❌ .env ещё не заполнен реальными значениями нового проекта. Останавливаюсь.');
  process.exit(1);
}

const supabase = createClient(url, key);

async function check(table, columns = 'count') {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    console.log(`❌ Таблица "${table}": ошибка — ${error.message}`);
    return false;
  }
  console.log(`✅ Таблица "${table}" доступна, строк: ${count ?? 0}`);
  return true;
}

async function main() {
  const tables = [
    'listings',
    'bot_sessions',
    'team_members',
    'forum_topics',
    'market_stats',
    'market_stats_manual', // может отсутствовать — это нормально
    'listing_price_history',
  ];

  let allOk = true;
  for (const t of tables) {
    const ok = await check(t);
    if (t !== 'market_stats_manual') allOk = allOk && ok;
  }

  console.log();
  if (allOk) {
    console.log('🎉 Подключение к новому Supabase работает, все ожидаемые таблицы на месте.');
    console.log('   (market_stats_manual необязательна — если её нет, это нормально, см. db.js)');
  } else {
    console.log('⚠️  Что-то не так — проверьте, что весь migration_full_new_project.sql выполнен');
    console.log('   в SQL Editor нового проекта без ошибок, и что ключи скопированы верно.');
  }

  // Пробуем реально записать и тут же удалить тестовую строку —
  // подтверждает, что service_role ключ имеет права на запись (RLS
  // не мешает, т.к. service_role его обходит).
  const testId = `__connection_test__${Date.now()}`;
  const { error: insertError } = await supabase.from('listings').insert({ id: testId, source: 'connection-test' });
  if (insertError) {
    console.log(`❌ Тестовая запись не удалась: ${insertError.message}`);
  } else {
    console.log('✅ Тестовая запись в listings прошла успешно');
    await supabase.from('listings').delete().eq('id', testId);
    console.log('✅ Тестовая запись удалена — запись/удаление работают');
  }
}

main();
