-- Listing retention support. This migration only adds a nullable, normalized
-- publication timestamp and guarded preview/purge functions. It does NOT run
-- a purge or install a scheduler. Do not backfill published_at from created_at
-- or last_seen_at: those fields do not represent publication time.

alter table public.listings
  add column if not exists published_at timestamptz;

create index if not exists idx_listings_published_at
  on public.listings (published_at)
  where published_at is not null;

create table if not exists public.listing_retention_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  retention_days integer not null check (retention_days in (7, 14)),
  dry_run boolean not null,
  candidate_count bigint not null default 0,
  deleted_count integer not null default 0
);
alter table public.listing_retention_runs enable row level security;
revoke all on public.listing_retention_runs from anon, authenticated;
grant select, insert on public.listing_retention_runs to service_role;
grant usage, select on sequence public.listing_retention_runs_id_seq to service_role;

create or replace function public.preview_listing_retention(
  p_retention_days integer default 14,
  p_sample_limit integer default 20
)
returns table (candidate_count bigint, sample jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz;
begin
  if p_retention_days not in (7, 14) then
    raise exception 'p_retention_days must be 7 or 14';
  end if;
  if p_sample_limit < 0 or p_sample_limit > 100 then
    raise exception 'p_sample_limit must be between 0 and 100';
  end if;
  v_cutoff := now() - make_interval(days => p_retention_days);

  return query
    select count(*)::bigint,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', candidate.id,
          'source', candidate.source,
          'deal_type', candidate.deal_type,
          'published_at', candidate.published_at
        ) order by candidate.published_at, candidate.id)
        from (
          select l.id, l.source, l.deal_type, l.published_at
          from public.listings l
          where l.published_at is not null and l.published_at < v_cutoff
          order by l.published_at, l.id
          limit p_sample_limit
        ) candidate
      ), '[]'::jsonb)
    from public.listings l
    where l.published_at is not null and l.published_at < v_cutoff;
end;
$$;

create or replace function public.purge_stale_listings(
  p_retention_days integer default 14,
  p_batch_size integer default 200,
  p_dry_run boolean default true,
  p_backup_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz;
  v_candidates bigint;
  v_ids text[];
  v_deleted integer := 0;
begin
  if p_retention_days not in (7, 14) then
    raise exception 'p_retention_days must be 7 or 14';
  end if;
  if p_batch_size < 1 or p_batch_size > 200 then
    raise exception 'p_batch_size must be between 1 and 200';
  end if;
  if not p_dry_run and not p_backup_confirmed then
    raise exception 'a verified off-site backup is required before deletion';
  end if;
  v_cutoff := now() - make_interval(days => p_retention_days);
  select count(*) into v_candidates
    from public.listings l
    where l.published_at is not null and l.published_at < v_cutoff;

  if p_dry_run then
    insert into public.listing_retention_runs (retention_days, dry_run, candidate_count, deleted_count)
    values (p_retention_days, true, v_candidates, 0);
    return jsonb_build_object('dry_run', true, 'retention_days', p_retention_days,
      'candidate_count', v_candidates, 'deleted_count', 0);
  end if;

  if not pg_try_advisory_xact_lock(74190217) then
    raise exception 'another listing retention run is active';
  end if;

  -- Lock a small ordered batch. Archive exists in the verified external
  -- workflow artifact; the FK cascade removes child price-history rows only
  -- after that artifact was uploaded successfully.
  with candidates as (
    select l.id
    from public.listings l
    where l.published_at is not null and l.published_at < v_cutoff
    order by l.published_at, l.id
    limit p_batch_size
    for update skip locked
  )
  select coalesce(array_agg(id), array[]::text[]) into v_ids from candidates;

  if cardinality(v_ids) > 0 then
    delete from public.listings where id = any(v_ids);
    get diagnostics v_deleted = row_count;
    if v_deleted <> cardinality(v_ids) then
      raise exception 'candidate row count changed during cleanup';
    end if;
  end if;

  insert into public.listing_retention_runs (retention_days, dry_run, candidate_count, deleted_count)
  values (p_retention_days, false, v_candidates, v_deleted);
  return jsonb_build_object('dry_run', false, 'retention_days', p_retention_days,
    'candidate_count', v_candidates, 'deleted_count', v_deleted,
    'remaining_candidates', greatest(v_candidates - v_deleted, 0));
end;
$$;

revoke all on function public.preview_listing_retention(integer, integer) from public, anon, authenticated;
revoke all on function public.purge_stale_listings(integer, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.preview_listing_retention(integer, integer) to service_role;
grant execute on function public.purge_stale_listings(integer, integer, boolean, boolean) to service_role;
