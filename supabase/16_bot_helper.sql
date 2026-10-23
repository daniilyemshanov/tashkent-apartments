-- Журнал подсказок бота-помощника (client/api/_chatHelper.js).
-- Нужен для двух вещей:
--   1) кулдауны — чтобы бот не подсказывал одному человеку по кругу;
--   2) payload кнопок подсказок («Искать это», «Сохранить как заметку»,
--      «Пометить как агента») — в callback_data влезает только 64 байта,
--      поэтому сам текст/ID храним тут, а в кнопке — id строки.
-- Старые строки (>7 дней) бот чистит сам, отдельный cron не нужен.

create table if not exists bot_help_log (
  id bigserial primary key,
  chat_id bigint not null,
  user_id bigint not null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_bot_help_log_cooldown
  on bot_help_log (chat_id, user_id, kind, created_at desc);

-- Как и у bot_sessions: RLS включён, публичных политик нет — доступ только
-- через service_role из Telegram-вебхука.
alter table bot_help_log enable row level security;
