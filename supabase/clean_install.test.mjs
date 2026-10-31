import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = (await readFile(new URL('./clean_install.sql', import.meta.url), 'utf8')).toLowerCase();
const dbSource = await readFile(new URL('../scraper/src/db.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../client/api/telegram-webhook.js', import.meta.url), 'utf8');

const requiredTables = [
  'listings', 'team_members', 'bot_sessions', 'forum_topics', 'market_stats',
  'listing_price_history', 'bot_help_log', 'market_stats_manual', 'telegram_processed_updates',
];
const requiredListingColumns = [
  'telegram_chat_id', 'telegram_message_id', 'telegram_deleted', 'market_stats_source', 'published_at',
  'assigned_to', 'contacted_by', 'flagged_agent', 'phone_normalized', 'market_segment', 'entity_key',
];

test('clean installer creates every table used by application code', () => {
  for (const table of requiredTables) assert.match(sql, new RegExp(`create table if not exists (?:public\\.)?${table}\\b`));
});

test('clean installer contains all previously missing listing fields and market fallback', () => {
  for (const column of requiredListingColumns) assert.match(sql, new RegExp(`add column if not exists ${column}\\b`));
  assert.match(sql, /create table if not exists public\.market_stats_manual/);
});

test('scraper db.js exports every helper the scraper imports', () => {
  for (const name of ['getListingById', 'getListingsLiteByIds', 'saveListing', 'markNotified', 'getTopicId', 'getTopicIdStrict', 'saveTopicId']) {
    assert.match(dbSource, new RegExp(`export async function ${name}\\b`));
  }
});

test('Telegram webhook RPC exists and is restricted to service_role', () => {
  assert.match(appSource, /rpc\('claim_telegram_update'/);
  assert.match(sql, /create or replace function public\.claim_telegram_update\(p_update_id bigint\)/);
  assert.match(sql, /grant execute on function public\.claim_telegram_update\(bigint\) to service_role/);
  assert.match(sql, /revoke all on function public\.claim_telegram_update\(bigint\) from public, anon, authenticated/);
});

test('installer is repeatable, closes browser roles, and leaves purge RPC absent', () => {
  assert.doesNotMatch(sql, /ваш-email@пример\.com|your-email@example\.com/);
  assert.doesNotMatch(sql, /create or replace function public\.purge_stale_listings/);
  assert.match(sql, /revoke all on schema public from public, anon, authenticated/);
  assert.match(sql, /alter table public\.listing_price_history enable row level security/);
  assert.match(sql, /on delete cascade/);
  assert.match(sql, /add column if not exists telegram_deleted/);
});