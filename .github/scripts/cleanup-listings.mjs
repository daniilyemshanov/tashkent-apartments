const BASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const configuredDays = Number(process.env.LISTING_RETENTION_DAYS || 14);
const RETENTION_DAYS = configuredDays === 7 ? 7 : 14;
const TIMEOUT_MS = 10000;

async function rpc(name, args) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Supabase RPC HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (!BASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase workflow secrets');
  if (![7, 14].includes(configuredDays)) throw new Error('LISTING_RETENTION_DAYS must be 7 or 14');
  const preview = await rpc('preview_listing_retention', {
    p_retention_days: RETENTION_DAYS,
    p_sample_limit: 20,
  });
  const previewRow = Array.isArray(preview) ? preview[0] : preview;
  console.log(JSON.stringify({ event: 'listing_retention_preview', retention_days: RETENTION_DAYS, candidate_count: previewRow?.candidate_count, sample: previewRow?.sample }));
  if (process.argv.includes('--preview')) return;
  if (!process.argv.includes('--purge')) throw new Error('Select --preview or --purge');

  const result = await rpc('purge_stale_listings', {
    p_retention_days: RETENTION_DAYS,
    p_batch_size: 200,
    p_dry_run: false,
    p_backup_confirmed: true,
  });
  console.log(JSON.stringify({ event: 'listing_retention_purge', retention_days: RETENTION_DAYS, result }));
}

main().catch((error) => {
  // Do not print error objects, request URLs, headers, or response bodies.
  console.error(JSON.stringify({ event: 'listing_retention_failed', reason: error?.name === 'AbortError' ? 'timeout' : 'request_or_configuration_error' }));
  process.exitCode = 1;
});
