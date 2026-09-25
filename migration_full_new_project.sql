-- ============================================================
-- Полный SQL для нового Supabase-проекта (tashkent-apartments)
-- Собрано автоматически из: schema.sql + 01..15 (в этом порядке)
-- Выполнить целиком одним запуском в SQL Editor нового проекта.
-- ============================================================

-- ===== schema.sql =====
-- Выполнить один раз в Supabase: Project → SQL Editor → New query → вставить и Run

create table if not exists listings (
  id text primary key,
  source text,
  deal_type text,
  property_type text default 'apartment', -- 'apartment' | 'house' | 'commercial'
  url text,
  title text,
  price text,
  posted_raw text,
  raw_text text,
  district text,
  district_raw text,
  price_value numeric,
  price_currency text, -- 'USD' | 'UZS'
  rooms integer,
  area double precision,
  phone text,
  seller_type text,
  confidence text,
  label_text text,
  label_kind text,
  seller_name text,
  seller_listings_count integer,
  notified boolean default false,
  contacted boolean default false,
  created_at timestamptz default now()
);

-- Row Level Security: включаем и НЕ добавляем разрешающих политик.
-- Это значит "запретить всё по умолчанию" — весь доступ идёт только
-- через наш /api (Vercel), который использует service_role ключ и
-- обходит RLS. Анонимный ключ (он публично лежит в JS-бандле сайта)
-- при такой настройке не даёт прочитать ни строки напрямую из
-- Supabase REST API, минуя нашу проверку авторизации.
alter table listings enable row level security;

-- Состояние "мастера" поиска в Telegram-боте (см. client/api/telegram-webhook.js).
create table if not exists bot_sessions (
  chat_id bigint not null,
  user_id bigint not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (chat_id, user_id)
);

-- Тоже без публичных политик — доступ только через service_role в
-- Telegram-вебхуке.
alter table bot_sessions enable row level security;

-- ===== 01_seller_fields.sql =====
-- Выполнить ОДИН РАЗ в Supabase SQL Editor, если таблица listings
-- уже была создана раньше (иначе саму schema.sql заново запускать
-- не нужно — create table if not exists её не тронет).

alter table listings add column if not exists seller_name text;
alter table listings add column if not exists seller_listings_count integer;

-- ===== 02_team_access.sql =====
-- Выполнить в Supabase SQL Editor.
-- Добавляет систему доступа: только те, кто в team_members, могут
-- входить и видеть объявления. Любой уже добавленный человек может
-- пригласить нового (добавить его email в эту таблицу).

create table if not exists team_members (
  email text primary key,
  added_by text,
  -- 'owner' — может приглашать, менять роли и удалять; 'admin' — обычный
  -- участник команды, видит список, но не управляет им. Обычных
  -- участников (без права даже видеть список) пока не вводим.
  role text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz default now()
);

-- RLS без разрешающих политик = запрет на прямой доступ через анонимный
-- ключ. Иначе кто угодно с anon-ключом (он публичен, лежит в JS-бандле)
-- мог бы вставить свою почту в эту таблицу с ролью owner и обойти всю
-- систему авторизации сайта. Доступ — только через service_role в /api.
alter table team_members enable row level security;

-- Впишите СВОЙ email — тот, которым будете входить первым. Именно он
-- становится владельцем (role = 'owner') — только владелец может
-- приглашать людей и назначать роли. Без этой строки войти будет
-- некому, даже вам.
-- !!! ЗАМЕНИТЕ email ниже на СВОЙ реальный — иначе войти в /client
-- (админку) на новом проекте будет некому.
insert into team_members (email, added_by, role)
values ('ваш-email@пример.com', 'initial', 'owner')
on conflict (email) do nothing;

-- ВАЖНО: см. также migration_fix_rls_security.sql — он закрывает
-- публичную политику чтения на listings, которая была включена по
-- ошибке (см. историю миграций).

-- ===== 03_property_type.sql =====
-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Добавляет колонку property_type ('apartment' | 'house' | 'commercial'),
-- нужна для фильтра "квартиры / дома / коммерция" на сайте и в боте.

alter table listings add column if not exists property_type text default 'apartment';

-- ===== 04_search_fields.sql =====
-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Добавляет поля, нужные для поиска/фильтра в Telegram-боте:
--   - price_value / price_currency — цена как число + валюта (для
--     фильтра по диапазону; price остаётся текстом для отображения).
--   - district_raw — необработанное название района (для отладки
--     нормализации), сам district теперь хранит УЖЕ каноничное
--     название (см. scraper/src/districts.js).
-- Плюс таблица bot_sessions — хранит состояние "мастера" поиска
-- (какой шаг сейчас проходит пользователь в группе, что уже выбрал),
-- т.к. serverless-функция Vercel не имеет памяти между запросами.

alter table listings add column if not exists price_value numeric;
alter table listings add column if not exists price_currency text; -- 'USD' | 'UZS'
alter table listings add column if not exists district_raw text;

create table if not exists bot_sessions (
  chat_id bigint not null,
  user_id bigint not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (chat_id, user_id)
);

-- Старые незавершённые "мастера поиска" никого не интересуют —
-- не обязательно, но полезно на будущее: можно периодически чистить
-- строки с updated_at старше суток. RLS не включаем — таблица
-- используется только через service_role ключ (Vercel API).

-- ===== 05_roles.sql =====
-- Выполнить в Supabase SQL Editor (для УЖЕ существующей установки,
-- где таблица team_members создана без роли — см. migration_team_access.sql).
-- Если ставите систему с нуля — role уже заложена в
-- migration_team_access.sql, этот файл не нужен.

alter table team_members
  add column if not exists role text not null default 'admin'
  check (role in ('owner', 'admin'));

-- Первый человек, кто был добавлен в команду (по created_at),
-- становится владельцем — если владельца ещё нет вообще.
-- Если у вас уже есть конкретный email, который должен быть
-- владельцем, надёжнее выполнить вручную:
--   update team_members set role = 'owner' where email = 'ваш-email@пример.com';
do $$
begin
  if not exists (select 1 from team_members where role = 'owner') then
    update team_members
    set role = 'owner'
    where email = (select email from team_members order by created_at asc limit 1);
  end if;
end $$;

-- ===== 06_forum_topics.sql =====
-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Хранит соответствие "тип недвижимости + район" → ID темы (topic) в
-- соответствующей Telegram-супергруппе. Заполняется автоматически
-- скриптом scraper/src/setup-topics.js при первом запуске.

create table if not exists forum_topics (
  group_key text not null,       -- 'apartment' | 'commercial' | 'house'
  district text not null,        -- каноничное имя района (см. districts.js)
  message_thread_id integer not null,
  created_at timestamptz default now(),
  primary key (group_key, district)
);

-- ===== 07_agent_actions.sql =====
-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для новых кнопок "✅ Связался" / "👤 Беру в работу" прямо в
-- Telegram-сообщении с объявлением — раньше "связался" можно было
-- отметить только на сайте, а "кто взял в работу" не отслеживалось
-- вообще. Теперь оба действия сохраняются в базе и видны и в
-- Telegram (сообщение само обновляется), и на сайте.

alter table listings add column if not exists assigned_to text;      -- кто взял объявление в работу (имя/username из Telegram)
alter table listings add column if not exists assigned_at timestamptz;
alter table listings add column if not exists contacted_by text;     -- кто отметил "связался" (Telegram-имя или email с сайта)
alter table listings add column if not exists contacted_at timestamptz;

-- ===== 08_flag_notes.sql =====
-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для новых кнопок "🚫 Это агент" и "📝 Заметка" на карточках
-- объявлений в Telegram.

alter table listings add column if not exists flagged_agent boolean default false; -- агент вручную пометил как "на самом деле агентство"
alter table listings add column if not exists flagged_by text;
alter table listings add column if not exists flagged_at timestamptz;
alter table listings add column if not exists notes text; -- свободная заметка агента ("перезвонить завтра" и т.п.)

-- ===== 09_image_url.sql =====
-- Картинка объявления (og:image со страницы OLX/Realting, media из API Uybor).
-- Выполнить один раз в Supabase → SQL Editor.
alter table listings add column if not exists image_url text;

-- ===== 10_phone_normalized.sql =====
-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Нужна для проверки "один и тот же номер телефона — на нескольких
-- РАЗНЫХ объявлениях" (сильный сигнал агента/риелтора — см.
-- scraper/src/db.js: countListingsByPhone, scraper/src/phone.js).
--
-- Колонка phone у нас хранит номер как есть, с разным форматированием
-- у разных источников ("+99 893 1804767" vs "998901234567" и т.п.),
-- поэтому для СРАВНЕНИЯ используем отдельную нормализованную колонку
-- (последние 9 цифр номера), а исходную phone не трогаем — она нужна
-- для отображения в Telegram/на сайте как есть.

alter table listings add column if not exists phone_normalized text;

-- Индекс — чтобы countListingsByPhone не сканировал всю таблицу на
-- каждое новое объявление (прогон раз в 15 минут, объявлений со
-- временем накопится много).
create index if not exists listings_phone_normalized_idx on listings (phone_normalized);

-- (11_clean_css_garbage.sql сознательно пропущен — это разовая
-- очистка МУСОРА В УЖЕ СУЩЕСТВУЮЩИХ строках старой базы (CSS-текст,
-- протёкший из-за старого бага OLX-парсера). На новой пустой базе
-- строк ещё нет, чистить нечего — сам баг в парсере давно исправлен.)

-- ===== 12_market_deals.sql =====
-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для детектора "ниже рыночной цены / быстрый уход" — см.
-- scraper/src/marketStats.js, scraper/src/listingDetails.js,
-- scraper/src/urgencySignals.js.

-- Площадь и комнаты раньше заполнялись ТОЛЬКО через ИИ-классификацию
-- (classify.js), которая сейчас отключена (USE_AI_CLASSIFICATION =
-- false) — то есть оба поля были всегда null. Теперь их дополнительно
-- заполняет бесплатный regex-парсер текста объявления (см.
-- listingDetails.js), area/rooms в схеме уже были — просто раньше
-- пустовали.

alter table listings add column if not exists price_per_sqm numeric; -- price_value / area, только когда обе части известны и в одной валюте
alter table listings add column if not exists below_market boolean default false; -- цена/м² заметно ниже медианы по своей группе (район+тип+сделка+валюта)
alter table listings add column if not exists below_market_pct numeric; -- на сколько % ниже медианы (округлено до 0.1)
alter table listings add column if not exists market_sample_size integer; -- сколько объявлений в группе легло в основу медианы — для прозрачности ("мало данных" на карточке)
alter table listings add column if not exists urgency_signal boolean default false; -- в тексте объявления есть слово-маркер срочности ("срочно", "торг" и т.п.)
alter table listings add column if not exists urgency_phrase text; -- какое именно слово/фраза сработали

-- Медианы цены за м² по группам (район+тип недвижимости+тип сделки+
-- валюта), пересчитывается раз в сутки (см. refreshMarketStatsIfStale
-- в marketStats.js, вызывается в начале run.js). Кроме групп по
-- конкретному району, тут же лежат и общегородские группы
-- (district = '__город__') — запасной вариант, когда по конкретному
-- району накопилось слишком мало объявлений для надёжной медианы.
create table if not exists market_stats (
  group_key text primary key, -- 'property_type|deal_type|district|currency', например 'apartment|sale|Чиланзар|USD'
  property_type text,
  deal_type text,
  district text,
  currency text,
  median_price_per_sqm numeric,
  sample_size integer,
  updated_at timestamptz default now()
);

-- ===== 13_fix_rls_security.sql =====
-- Выполнить ОДИН РАЗ в Supabase SQL Editor (Project → SQL Editor → New query → Run).
--
-- Закрывает две дыры в безопасности, актуальные для уже созданной базы
-- (schema.sql и migration_team_access.sql в старом виде их не покрывают,
-- т.к. применяются только при первой установке):
--
-- 1. На listings была публичная политика чтения ("Публичное чтение",
--    for select using (true)). Анонимный ключ Supabase публично лежит
--    в JS-бандле сайта, так что любой, кто его достанет, мог напрямую
--    читать все объявления (включая телефоны продавцов) через Supabase
--    REST API, в обход входа по email.
--
-- 2. На team_members и bot_sessions RLS вообще не был включён. По
--    умолчанию Supabase даёт роли anon права на чтение/запись в
--    public-схему — то есть кто угодно с анонимным ключом теоретически
--    мог вставить свою почту в team_members с ролью owner напрямую
--    через REST API, полностью обойдя авторизацию сайта.

-- 1. Убираем публичное чтение listings.
drop policy if exists "Публичное чтение" on listings;

-- На случай, если RLS ещё не был включён.
alter table listings enable row level security;

-- 2. Включаем RLS на team_members и bot_sessions без разрешающих
--    политик — это запрещает прямой доступ через анонимный ключ.
--    Весь легитимный доступ идёт через /api (Vercel), который
--    использует service_role ключ и RLS не касается.
alter table team_members enable row level security;
alter table bot_sessions enable row level security;

-- 3. На всякий случай явно забираем дефолтные права у ролей anon и
--    authenticated на схему public — так безопасность не будет
--    держаться только на RLS-политиках (или их отсутствии), а будет
--    подкреплена и на уровне грантов.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- Проверка после выполнения (не обязательно, но полезно):
-- select tablename, rowsecurity from pg_tables where schemaname = 'public';
-- select * from pg_policies where schemaname = 'public';
-- В первом запросе rowsecurity должно быть true у listings, team_members,
-- bot_sessions. Во втором — не должно остаться политик на listings.

-- ===== 14_market_segment.sql =====
-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для точности "ниже рыночной цены" — см. scraper/src/marketSegment.js,
-- scraper/src/marketStats.js (segmentedGroupKey, фолбэк-цепочка в evaluateDeal).
--
-- Проблема, которую решает: в одном районе Ташкента (особенно
-- центральные — Шайхантахурский, Юнусабадский и т.п.) одновременно
-- продаётся дешёвая старая вторичка (~$800-1500/м²) и элитные
-- новостройки/ЖК (~$3000-5000+/м²). Раньше медиана считалась по
-- району БЕЗ разделения на эти сегменты — при небольшой выборке
-- (MIN_SAMPLE=5) даже 1-2 объявления из новостройки утягивали медиану
-- района вверх, и обычная вторичка начинала ложно выглядеть "на 40-50%
-- дешевле рынка", хотя на самом деле просто сравнивалась не с тем
-- сегментом.
--
-- market_segment заполняется бесплатным regex-детектором по тексту
-- объявления (явные фразы "Вторичный рынок" / "Новостройка" — см.
-- marketSegment.js), без ИИ. Значение null — ожидаемо и безопасно:
-- объявление просто продолжает участвовать в старой (несегментированной)
-- группе района, как и раньше, ничего не ломается.

alter table listings add column if not exists market_segment text; -- 'new_build' | 'secondary' | null

-- market_stats.group_key уже text-строка произвольного формата
-- (см. 12_market_deals.sql) — сегментированные ключи вида
-- 'apartment|sale|Чиланзарский|secondary' пишутся туда же, без
-- изменений схемы этой таблицы.

-- ===== 15_deal_scoring.sql =====
-- Выполнить один раз в Supabase SQL Editor.
-- Добавляет поля для нового Deal Score, истории цены и подавления
-- дублей без поломки существующих групп Telegram.

alter table listings add column if not exists entity_key text; -- стабильный ключ сущности: phone/url/text hash
alter table listings add column if not exists is_duplicate boolean default false; -- повтор того же объекта, который не нужно отправлять как новое объявление
alter table listings add column if not exists duplicate_of_id text; -- id канонического объявления, если это повтор
alter table listings add column if not exists duplicate_reason text; -- краткое объяснение, почему признали дублем

alter table listings add column if not exists deal_candidate boolean default false; -- попадает ли объявление в группу "Выгодные"
alter table listings add column if not exists deal_score numeric; -- итоговый балл 0-100
alter table listings add column if not exists owner_score numeric; -- вероятность/сила сигнала собственника 0-100
alter table listings add column if not exists deal_score_breakdown jsonb default '{}'::jsonb; -- компоненты скоринга для отладки/карточек
alter table listings add column if not exists owner_score_breakdown jsonb default '{}'::jsonb; -- признаки, из которых собран Owner Score

alter table listings add column if not exists price_history jsonb default '[]'::jsonb; -- массив наблюдений цены по одному listing id
alter table listings add column if not exists price_history_count integer default 0; -- сколько наблюдений накопили
alter table listings add column if not exists price_drop_count integer default 0; -- сколько раз цена снижалась
alter table listings add column if not exists price_change_count integer default 0; -- сколько раз цена менялась вообще
alter table listings add column if not exists first_seen_price_value numeric; -- первая зафиксированная цена
alter table listings add column if not exists last_seen_price_value numeric; -- последняя зафиксированная цена
alter table listings add column if not exists last_price_change_pct numeric; -- последнее изменение цены в процентах
alter table listings add column if not exists last_price_change_at timestamptz; -- когда была последняя смена цены
alter table listings add column if not exists last_seen_at timestamptz; -- когда последний раз видели объявление

-- Таблица истории наблюдений нужна для аудита и для будущих более
-- детальных исследований цены/событий, если понадобится отдельный
-- отчёт по таймлайну.
create table if not exists listing_price_history (
  id bigserial primary key,
  listing_id text not null references listings(id) on delete cascade,
  observed_at timestamptz not null default now(),
  price_value numeric,
  price_currency text,
  price_text text,
  price_per_sqm numeric,
  price_usd numeric,
  source text,
  created_at timestamptz default now()
);

create index if not exists idx_listing_price_history_listing_id_observed_at
  on listing_price_history (listing_id, observed_at desc);

