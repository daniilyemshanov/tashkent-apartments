-- Выполнить ОДИН РАЗ в Supabase SQL Editor (после 17_listing_retention.sql
-- или без неё — от неё эта миграция не зависит).
--
-- Что делает: добавляет функцию public.daily_cleanup(), которую раз в сутки
-- вызывает GitHub Actions (.github/workflows/daily-cleanup.yml), чтобы база
-- не упиралась в лимит бесплатного плана (500 МБ). За один вызов функция:
--
--   1. стирает raw_text (самое тяжёлое поле):
--        - у агентских объявлений — сразу (их не показываем ни в Telegram,
--          ни на сайте, для дедупа хватает entity_key и телефона);
--        - у остальных — когда им больше p_text_days дней;
--   2. обрезает price_history до последних 30 записей;
--   3. удаляет старые объявления:
--        - обычные — старше p_keep_days дней (по умолчанию 14);
--        - агентские — старше p_keep_agent_days (по умолчанию 30): строки
--          маленькие, а их телефоны нужны, чтобы замечать, что один номер
--          висит на куче объявлений (признак агентства);
--        - НЕ удаляет объявления, с которыми команда уже работала:
--          contacted = true, assigned_to / notes заполнены, или
--          flagged_agent = true;
--   4. возвращает размер базы и таблицы (для алерта в Telegram).
--
-- Возраст объявления = coalesce(published_at, created_at). published_at
-- заполняется скрапером, когда сайт отдаёт понятную дату; иначе берётся
-- момент, когда мы впервые увидели объявление (скрапер смотрит только
-- свежие объявления, поэтому разница небольшая).
--
-- p_dry_run = true (по умолчанию) — только считает, ничего не меняет.
-- Один вызов обрабатывает не больше p_batch_size строк каждого вида;
-- скрипт .github/scripts/daily-cleanup.mjs повторяет вызов, пока не
-- останется работы.

create or replace function public.daily_cleanup(
  p_keep_days integer default 14,
  p_keep_agent_days integer default 30,
  p_text_days integer default 7,
  p_batch_size integer default 2000,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purge_cutoff timestamptz;
  v_agent_cutoff timestamptz;
  v_text_cutoff timestamptz;
  v_slim_candidates bigint;
  v_trim_candidates bigint;
  v_purge_candidates bigint;
  v_slimmed integer := 0;
  v_trimmed integer := 0;
  v_purged integer := 0;
  v_ids text[];
begin
  if p_keep_days < 7 or p_keep_days > 90 then
    raise exception 'p_keep_days must be between 7 and 90';
  end if;
  if p_keep_agent_days < p_keep_days or p_keep_agent_days > 180 then
    raise exception 'p_keep_agent_days must be between p_keep_days and 180';
  end if;
  if p_text_days < 2 or p_text_days > p_keep_days then
    raise exception 'p_text_days must be between 2 and p_keep_days';
  end if;
  if p_batch_size < 100 or p_batch_size > 20000 then
    raise exception 'p_batch_size must be between 100 and 20000';
  end if;

  v_purge_cutoff := now() - make_interval(days => p_keep_days);
  v_agent_cutoff := now() - make_interval(days => p_keep_agent_days);
  v_text_cutoff  := now() - make_interval(days => p_text_days);

  select count(*) into v_slim_candidates
    from public.listings l
    where l.raw_text is not null
      and (l.label_kind = 'agent' or coalesce(l.published_at, l.created_at) < v_text_cutoff);

  select count(*) into v_trim_candidates
    from public.listings l
    where jsonb_typeof(l.price_history) = 'array' and jsonb_array_length(l.price_history) > 30;

  select count(*) into v_purge_candidates
    from public.listings l
    where coalesce(l.published_at, l.created_at) <
            case when l.label_kind = 'agent' then v_agent_cutoff else v_purge_cutoff end
      and not coalesce(l.contacted, false)
      and not coalesce(l.flagged_agent, false)
      and l.assigned_to is null
      and l.notes is null;

  if not p_dry_run then
    if not pg_try_advisory_xact_lock(74190218) then
      raise exception 'another daily_cleanup run is active';
    end if;

    -- 1. raw_text
    with c as (
      select l.id from public.listings l
      where l.raw_text is not null
        and (l.label_kind = 'agent' or coalesce(l.published_at, l.created_at) < v_text_cutoff)
      limit p_batch_size
      for update skip locked
    )
    update public.listings l set raw_text = null from c where l.id = c.id;
    get diagnostics v_slimmed = row_count;

    -- 2. price_history: оставляем последние 30 наблюдений (порядок сохраняется)
    with c as (
      select l.id from public.listings l
      where jsonb_typeof(l.price_history) = 'array' and jsonb_array_length(l.price_history) > 30
      limit p_batch_size
      for update skip locked
    )
    update public.listings l
      set price_history = (
        select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb)
        from (
          select e, n
          from jsonb_array_elements(l.price_history) with ordinality as x(e, n)
          order by n desc
          limit 30
        ) t
      )
    from c where l.id = c.id;
    get diagnostics v_trimmed = row_count;

    -- 3. удаление старых (listing_price_history уходит каскадом)
    with c as (
      select l.id from public.listings l
      where coalesce(l.published_at, l.created_at) <
              case when l.label_kind = 'agent' then v_agent_cutoff else v_purge_cutoff end
        and not coalesce(l.contacted, false)
        and not coalesce(l.flagged_agent, false)
        and l.assigned_to is null
        and l.notes is null
      order by coalesce(l.published_at, l.created_at), l.id
      limit p_batch_size
      for update skip locked
    )
    select coalesce(array_agg(id), array[]::text[]) into v_ids from c;

    if cardinality(v_ids) > 0 then
      delete from public.listings where id = any(v_ids);
      get diagnostics v_purged = row_count;
    end if;
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'slim_candidates', v_slim_candidates,
    'trim_candidates', v_trim_candidates,
    'purge_candidates', v_purge_candidates,
    'slimmed', v_slimmed,
    'trimmed', v_trimmed,
    'purged', v_purged,
    'batch_size', p_batch_size,
    'db_bytes', pg_database_size(current_database()),
    'listings_bytes', pg_total_relation_size('public.listings')
  );
end;
$$;

revoke all on function public.daily_cleanup(integer, integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.daily_cleanup(integer, integer, integer, integer, boolean)
  to service_role;

notify pgrst, 'reload schema';
