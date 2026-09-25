Пакет для переноса скрапера "apartmens" на новый Supabase-проект
==================================================================

Файлы:
- migration_full_new_project.sql — прогнать целиком в SQL Editor
  нового проекта (Project → SQL Editor → New query → вставить → Run).
  ПЕРЕД запуском замените 'ваш-email@пример.com' (строка помечена !!!)
  на свой настоящий email — иначе некому будет войти в админку сайта.

- scraper.env.new — переименовать в scraper/.env (заменить текущий).
  SUPABASE_URL уже проставлен. SUPABASE_SERVICE_KEY пока плейсхолдер
  "НОВЫЙ_SERVICE_ROLE_KEY_СЮДА" — впишите свой service_role
  (или secret) ключ из Settings → API Keys нового проекта.

- client.env.new — переименовать в client/.env (заменить текущий).
  Полностью готов (URL + anon key уже вписаны).

- test-new-supabase-connection.js — положить в scraper/ и запустить
  `node test-new-supabase-connection.js` ПОСЛЕ того, как scraper.env
  заполнен реальным service_role ключом. Проверяет, что все таблицы
  на месте и что запись/удаление работают.

После этого ещё нужно (я подскажу детали, когда буду знать service_role key):
1. Обновить GitHub Secrets (SUPABASE_URL, SUPABASE_SERVICE_KEY) — для
   .github/workflows/scrape.yml
2. Обновить переменные окружения в Vercel (SUPABASE_URL,
   SUPABASE_SERVICE_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
3. Если используется deploy/tashkent-scraper.service на VPS —
   обновить /opt/tashkent-apartments-v2/scraper/.env тем же способом
