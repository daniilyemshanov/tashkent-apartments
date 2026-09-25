// Разовый скрипт: переносит таблицу forum_topics (район → id темы в
// Telegram-супергруппе) со СТАРОГО Supabase-проекта на НОВЫЙ.
//
// Зачем это вообще нужно:
// migration_full_new_project.sql создаёт forum_topics в новом проекте
// ПУСТОЙ (это только схема, без данных) — а Telegram-группы и темы в
// них остались физически теми же самыми (TELEGRAM_GROUP_* в .env не
// менялись при миграции). Значит привязка "район → id темы" есть
// только в старой базе. Если это не перенести, а просто запустить
// заново setup-topics.js на новой базе — он не увидит существующих
// тем (Bot API не даёт способа их перечислить) и создаст ДУБЛИКАТЫ
// тем в тех же группах. Поэтому переносим данные напрямую, а не
// пересоздаём темы.
//
// Запуск (один раз, после чего можно удалить):
//   OLD_SUPABASE_URL=https://...supabase.co \
//   OLD_SUPABASE_SERVICE_KEY=eyJ... \
//   node src/scripts/migrate-forum-topics.js
//
// NEW_* берутся из текущего scraper/.env (SUPABASE_URL / SUPABASE_SERVICE_KEY) —
// то есть .env должен уже быть переключён на новый проект.
//
// Значения для OLD_* — из scraper/.env.OLD_BACKUP (создан при миграции,
// не удаляйте его, пока не прогоните этот скрипт).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const OLD_URL = (process.env.OLD_SUPABASE_URL || '').trim();
const OLD_KEY = (process.env.OLD_SUPABASE_SERVICE_KEY || '').trim();
const NEW_URL = (process.env.SUPABASE_URL || '').trim();
const NEW_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

async function main() {
  if (!OLD_URL || !OLD_KEY) {
    console.error(
      'Не заданы OLD_SUPABASE_URL / OLD_SUPABASE_SERVICE_KEY.\n' +
        'Возьмите их из scraper/.env.OLD_BACKUP и передайте явно при запуске, например:\n' +
        '  OLD_SUPABASE_URL=... OLD_SUPABASE_SERVICE_KEY=... node src/scripts/migrate-forum-topics.js'
    );
    process.exit(1);
  }
  if (!NEW_URL || !NEW_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY (новый проект) не заданы в .env — переключите .env на новый проект перед запуском.');
    process.exit(1);
  }
  if (OLD_URL === NEW_URL) {
    console.error('OLD_SUPABASE_URL совпадает с текущим SUPABASE_URL из .env — похоже, .env ещё не переключён на новый проект.');
    process.exit(1);
  }

  const oldClient = createClient(OLD_URL, OLD_KEY);
  const newClient = createClient(NEW_URL, NEW_KEY);

  console.log(`Читаю forum_topics из старого проекта (${OLD_URL})...`);
  const { data: rows, error: readErr } = await oldClient.from('forum_topics').select('group_key, district, message_thread_id');
  if (readErr) {
    console.error('Не удалось прочитать forum_topics со старого проекта:', readErr.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.warn('В старом проекте forum_topics пуста — переносить нечего.');
    return;
  }
  console.log(`Найдено ${rows.length} тем. Переношу в новый проект (${NEW_URL})...`);

  const { error: writeErr } = await newClient
    .from('forum_topics')
    .upsert(rows, { onConflict: 'group_key,district' });

  if (writeErr) {
    console.error('Не удалось записать forum_topics в новый проект:', writeErr.message);
    console.error('Убедитесь, что миграция схемы (migration_full_new_project.sql) уже выполнена в новом проекте — таблица forum_topics должна существовать.');
    process.exit(1);
  }

  console.log(`✅ Перенесено ${rows.length} тем. Распределение по районам в тематических супергруппах снова будет работать.`);
  console.log('После проверки можно запустить setup-topics.js — он досоздаст темы только для новых районов, которых раньше не было, дублей не будет.');
}

main();
