-- Apply manually in Supabase before deploying code that calls this RPC.
-- Durable webhook idempotency shared by all Vercel instances.
create table if not exists public.telegram_processed_updates (
  update_id bigint primary key,
  expires_at timestamptz not null
);
create index if not exists telegram_processed_updates_expires_at_idx
  on public.telegram_processed_updates (expires_at);
alter table public.telegram_processed_updates enable row level security;

create or replace function public.claim_telegram_update(p_update_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed bigint;
begin
  insert into public.telegram_processed_updates (update_id, expires_at)
  values (p_update_id, now() + interval '10 minutes')
  on conflict (update_id) do update
    set expires_at = excluded.expires_at
    where public.telegram_processed_updates.expires_at <= now()
  returning update_id into claimed;

  -- Opportunistic cleanup keeps this idempotency table bounded.
  delete from public.telegram_processed_updates where expires_at <= now();
  return claimed is not null;
end;
$$;
revoke all on function public.claim_telegram_update(bigint) from public, anon, authenticated;
grant execute on function public.claim_telegram_update(bigint) to service_role;
