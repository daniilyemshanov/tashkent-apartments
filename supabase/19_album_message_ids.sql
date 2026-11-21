-- Пост-формат карточки (альбом фото + сообщение с картой и кнопками):
-- в telegram_message_id лежит id сообщения с кнопками, а id сообщений
-- самого альбома хранятся здесь — чтобы при пометке «Это агент» удалять
-- весь пост целиком, а не только кнопочное сообщение.
alter table public.listings
  add column if not exists telegram_extra_message_ids jsonb;
