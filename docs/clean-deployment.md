# Чистое развёртывание Tashkent Apartments

Этот сценарий создаёт только структуру приложения. Он не восстанавливает старые данные, не добавляет тестовых пользователей и не запускает удаление объявлений. К базе production не подключается.

## Файлы

- `supabase/clean_install.sql` — единый повторно запускаемый installer; запускать в Supabase SQL Editor под `postgres`.
- `supabase/bootstrap_owner.sql` — отдельный шаг после подтверждения email в Supabase Auth. Перед запуском заменить маркер на реальный адрес; не запускать с маркером.
- `supabase/check_clean_install.sql` — read-only SQL-проверка таблиц, колонок, RLS, grants, RPC и каскадного внешнего ключа.
- `supabase/clean_install.test.mjs` — локальные статические контрактные проверки installer.

## Порядок установки

1. В Supabase Dashboard открыть именно целевой проект, проверить Project Reference и убедиться, что старые данные не нужны. Не импортировать архивы или старые дампы.
2. В **Project Settings → API / Data API** оставить Data API включённым для `public` (приложение использует Supabase REST API) и выключить автоматическое предоставление доступа новым таблицам, если этот переключатель доступен. Installer в любом случае явно отзовёт доступ браузерным ролям и выдаст нужные права `service_role`. Для будущих public RPC обязательно задавать явные `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` и точечный `GRANT` только нужной серверной роли.
3. В **Authentication → Providers** включить Email OTP / magic link. Для первичной регистрации оставить разрешённой регистрацию пользователя. В **Authentication → URL Configuration** задать настоящий Site URL и точные redirect URL сайта/Vercel.
4. В веб-приложении запросить magic link на email будущего владельца и пройти подтверждение по письму. До появления подтверждённого пользователя в Auth создание владельца будет отклонено.
5. В **SQL Editor → New query** вставить целиком `supabase/clean_install.sql` и выполнить. Не запускать старый `migration_full_new_project.sql` поверх этого installer.
6. В отдельном SQL Editor запросе использовать `supabase/bootstrap_owner.sql`, заменить маркер на тот же подтверждённый email и выполнить один раз. Функция проверит существование подтверждённого пользователя, пустоту `team_members` и добавит владельца. Она недоступна через anon, authenticated и service_role. Не передавайте email в чат/логи.
7. Выполнить `supabase/check_clean_install.sql`. Он должен завершиться сообщением `Clean-install verification passed`.
8. Добавить/проверить переменные окружения в Vercel и GitHub Actions (см. ниже), развернуть сайт, затем вручную протестировать вход, авторизованные API и Telegram webhook.
9. Только после успешной smoke-проверки запустить workflow скрейпера вручную и проверить, что запись и обновление тестового реального объявления проходят. Затем проверить один штатный запуск мониторинга и backup.

Installer намеренно не создаёт `purge_stale_listings` и не включает retention. Оставьте `ENABLE_LISTING_RETENTION_PREVIEW` и `ENABLE_LISTING_RETENTION_CLEANUP` выключенными. Старый `supabase/17_listing_retention.sql` пока не запускайте. Успешный запуск backup/cleanup workflow не является подтверждением удаления; в текущей схеме очистка не активируется.

## Что создаётся

Таблицы приложения: `listings`, `team_members`, `bot_sessions`, `forum_topics`, `market_stats`, `listing_price_history`, `bot_help_log`, `market_stats_manual`, `telegram_processed_updates`.

У `listings` дополнены поля, которые использовались кодом, но отсутствовали в SQL: `telegram_chat_id`, `telegram_message_id`, `telegram_deleted`, `market_stats_source`, `published_at`. `listing_price_history.listing_id` сохраняет `ON DELETE CASCADE`.

В проекте нет прикладных триггеров, необходимых существующему коду: действия выполняются приложением или RPC. Единственный RPC приложения — `claim_telegram_update(bigint)`. `bootstrap_first_owner(text)` предназначен только для начальной настройки через Dashboard SQL Editor. Retention RPC не устанавливается.

## Переменные и секреты

**Vercel server environment:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, разрешённые chat ID / групповые ID. Service key должен быть доступен только serverless API, не `VITE_*` и не frontend build.

**Vercel frontend build:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Anon key является публичным идентификатором клиента; безопасность данных обеспечивается тем, что у anon/authenticated нет `USAGE` на `public`, прав на прикладные таблицы и разрешающих RLS policies.

**GitHub Actions secrets:** существующие для scraper `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, Telegram secrets; для мониторинга также `TELEGRAM_ADMIN_CHAT_ID`; для backup — `SUPABASE_DB_URL` (Postgres connection string). Секреты только в GitHub/Vercel secret stores, не в `.env` для коммита, SQL, выводе команд или логах.

Проверить отдельно, что GitHub-репозиторий приватный до включения backup artifacts с данными, Actions включены, workflow лежат в default branch, usage/storage в пределах бесплатных лимитов. Параметры cron-job.org нельзя вывести из репозитория; scrape workflow запускается только `workflow_dispatch`, пока внешний планировщик действительно вызывает его.

## Локальные команды проверки

Из корня репозитория:

```powershell
node --test supabase/clean_install.test.mjs
node --test client/api/_telegramApi.test.js client/api/_updateDedupe.test.js client/api/_dbErrors.test.js scraper/src/publicationDate.test.mjs .github/scripts/supabase-health-check.test.mjs
npm run build --prefix client
```

Для проверки разрешения импорта модуля работы с базой без соединения с ней (используются фиктивные process-local значения, запросов не выполняется):

```powershell
$env:SUPABASE_URL = 'https://contract-test.invalid'
$env:SUPABASE_SERVICE_KEY = 'contract-test-key'
node --input-type=module -e "await import('./scraper/src/db.js'); console.log('imports ok')"
Remove-Item Env:SUPABASE_URL, Env:SUPABASE_SERVICE_KEY
```

После установки запускать SQL-проверку из шага 7. Затем вручную проверить:

- вход по magic link подтверждённого владельца и отказ email вне `team_members`;
- `GET /api/listings` с токеном владельца и отказ без токена;
- anon Data API не может читать `listings`, `team_members`, `market_stats_manual` или вызывать `claim_telegram_update`;
- Telegram webhook: неправильный secret даёт 401, запрещённый chat игнорируется, разрешённое тестовое сообщение получает ответ; повтор одного update не обрабатывается дважды;
- `scraper` может читать `listings`, upsert'ить объявление, записывать историю цены/market stats и Telegram IDs, сохранять/читать `forum_topics`;
- мониторинг делает успешный Data API GET; backup выгружает схему/данные и успешно проверяет artifact. Ни один workflow не запускает удаление.

## Ограничения и риски

SQL статически проверен и покрыт контрактными тестами, но не был выполнен в PostgreSQL: production доступ запрещён, а локальный `psql` недоступен. Перед production нужна первая проверка в пустом временном/целевом проекте после вашего согласия. Действующие состояния GitHub secrets/variables, Auth settings, Vercel deployment и cron-job.org не подтверждены через Dashboard в этой сессии.