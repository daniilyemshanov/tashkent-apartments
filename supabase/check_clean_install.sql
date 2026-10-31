-- Read-only post-install verification. Run in Supabase SQL Editor as postgres.
do $$
declare
  missing text;
  v_table_name text;
  app_tables text[] := array[
    'listings', 'team_members', 'bot_sessions', 'forum_topics', 'market_stats',
    'listing_price_history', 'bot_help_log', 'market_stats_manual', 'telegram_processed_updates'
  ];
  required_columns jsonb := '{
    "listings":["id","source","deal_type","property_type","url","title","price","posted_raw","raw_text","district","district_raw","price_value","price_currency","rooms","area","phone","phone_normalized","seller_type","confidence","label_text","label_kind","seller_name","seller_listings_count","notified","contacted","contacted_by","contacted_at","assigned_to","assigned_at","flagged_agent","flagged_by","flagged_at","notes","image_url","price_per_sqm","below_market","below_market_pct","market_sample_size","urgency_signal","urgency_phrase","market_segment","entity_key","is_duplicate","duplicate_of_id","duplicate_reason","deal_candidate","deal_score","owner_score","deal_score_breakdown","owner_score_breakdown","price_history","price_history_count","price_drop_count","price_change_count","first_seen_price_value","last_seen_price_value","last_price_change_pct","last_price_change_at","last_seen_at","telegram_chat_id","telegram_message_id","telegram_deleted","market_stats_source","published_at","created_at"],
    "team_members":["email","added_by","role","created_at"],
    "bot_sessions":["chat_id","user_id","state","updated_at"],
    "forum_topics":["group_key","district","message_thread_id","created_at"],
    "market_stats":["group_key","property_type","deal_type","district","currency","median_price_per_sqm","sample_size","updated_at"],
    "listing_price_history":["id","listing_id","observed_at","price_value","price_currency","price_text","price_per_sqm","price_usd","source","created_at"],
    "bot_help_log":["id","chat_id","user_id","kind","payload","created_at"],
    "market_stats_manual":["group_key","property_type","deal_type","district","median_price_per_sqm","updated_at"],
    "telegram_processed_updates":["update_id","expires_at"]
  }'::jsonb;
begin
  foreach v_table_name in array app_tables loop
    if to_regclass(format('public.%I', v_table_name)) is null then
      raise exception 'Missing table public.%', v_table_name;
    end if;
    if not (select rowsecurity from pg_tables where schemaname='public' and tablename=v_table_name) then
      raise exception 'RLS is not enabled on public.%', v_table_name;
    end if;
    if exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=v_table_name) then
      raise exception 'Unexpected public policy found on public.%', v_table_name;
    end if;
    if has_table_privilege('anon', format('public.%I', v_table_name), 'SELECT')
       or has_table_privilege('anon', format('public.%I', v_table_name), 'INSERT')
       or has_table_privilege('anon', format('public.%I', v_table_name), 'UPDATE')
       or has_table_privilege('anon', format('public.%I', v_table_name), 'DELETE') then
      raise exception 'anon has table privileges on public.%', v_table_name;
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_table_name), 'SELECT')
       or has_table_privilege('authenticated', format('public.%I', v_table_name), 'INSERT')
       or has_table_privilege('authenticated', format('public.%I', v_table_name), 'UPDATE')
       or has_table_privilege('authenticated', format('public.%I', v_table_name), 'DELETE') then
      raise exception 'authenticated has direct table privileges on public.%', v_table_name;
    end if;
    if not has_table_privilege('service_role', format('public.%I', v_table_name), 'SELECT')
       or not has_table_privilege('service_role', format('public.%I', v_table_name), 'INSERT')
       or not has_table_privilege('service_role', format('public.%I', v_table_name), 'UPDATE')
       or not has_table_privilege('service_role', format('public.%I', v_table_name), 'DELETE') then
      raise exception 'service_role lacks required CRUD grants on public.%', v_table_name;
    end if;
    select string_agg(col, ', ') into missing
    from jsonb_array_elements_text(required_columns->v_table_name) as cols(col)
    where not exists (
      select 1 from information_schema.columns c
      where c.table_schema='public' and c.table_name=v_table_name and c.column_name=col
    );
    if missing is not null then
      raise exception 'Missing columns on public.%: %', v_table_name, missing;
    end if;
  end loop;

  if has_schema_privilege('anon','public','USAGE') or has_schema_privilege('authenticated','public','USAGE') then
    raise exception 'Browser roles unexpectedly have USAGE on schema public';
  end if;
  if not has_schema_privilege('service_role','public','USAGE') then
    raise exception 'service_role lacks USAGE on schema public';
  end if;
  if has_sequence_privilege('anon','public.listing_price_history_id_seq','USAGE')
     or has_sequence_privilege('authenticated','public.listing_price_history_id_seq','USAGE')
     or not has_sequence_privilege('service_role','public.listing_price_history_id_seq','USAGE') then
    raise exception 'listing price history sequence grants are incorrect';
  end if;
  if to_regprocedure('public.claim_telegram_update(bigint)') is null then
    raise exception 'Missing RPC claim_telegram_update(bigint)';
  end if;
  if not has_function_privilege('service_role','public.claim_telegram_update(bigint)','EXECUTE') then
    raise exception 'service_role cannot execute claim_telegram_update';
  end if;
  if has_function_privilege('anon','public.claim_telegram_update(bigint)','EXECUTE')
     or has_function_privilege('authenticated','public.claim_telegram_update(bigint)','EXECUTE') then
    raise exception 'Browser role can execute claim_telegram_update';
  end if;
  if to_regprocedure('public.bootstrap_first_owner(text)') is null then
    raise exception 'Missing first-owner bootstrap function';
  end if;
  if has_function_privilege('anon','public.bootstrap_first_owner(text)','EXECUTE')
     or has_function_privilege('authenticated','public.bootstrap_first_owner(text)','EXECUTE')
     or has_function_privilege('service_role','public.bootstrap_first_owner(text)','EXECUTE') then
    raise exception 'A non-owner role can execute first-owner bootstrap';
  end if;
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
    join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname='listing_price_history'
      and c.contype='f' and c.confdeltype='c' and c.confrelid='public.listings'::regclass
  ) then
    raise exception 'listing_price_history does not cascade on listing deletion';
  end if;
  if to_regclass('public.idx_listings_created_at_desc') is null
     or to_regclass('public.idx_listings_entity_key_created_at') is null
     or to_regclass('public.listings_phone_normalized_idx') is null
     or to_regclass('public.idx_listing_price_history_listing_id_observed_at') is null
     or to_regclass('public.idx_bot_help_log_cooldown') is null
     or to_regclass('public.idx_listings_published_at') is null
     or to_regclass('public.telegram_processed_updates_expires_at_idx') is null then
    raise exception 'One or more expected application indexes are missing';
  end if;
  if to_regprocedure('public.purge_stale_listings(integer,integer,boolean,boolean)') is not null
     or to_regprocedure('public.preview_listing_retention(integer,integer)') is not null then
    raise exception 'Retention RPC must remain absent until separately approved';
  end if;
  if exists (
    select 1 from pg_trigger tr join pg_class t on t.oid=tr.tgrelid
    join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname = any(app_tables) and not tr.tgisinternal
  ) then
    raise exception 'Unexpected application trigger found; this install expects no app triggers';
  end if;
  raise notice 'Clean-install verification passed: application tables, columns, RLS, grants, RPC, and FK.';
end;
$$;