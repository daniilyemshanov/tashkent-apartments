# Supabase reliability operations

This project now has repository workflows for an API health check and a weekly database export. These workflows are source-code only until they are merged into the repository's default branch, the required GitHub secrets exist, and Actions are enabled.

## What was present before

- `.github/workflows/scrape.yml` only declares `workflow_dispatch`; the README says an external cron-job.org schedule triggers it. The cron-job.org account settings/history are not stored in this repository and could not be inspected here.
- `deploy/tashkent-scraper.timer` is an alternative 15-minute systemd timer. The file does not prove that a VPS is running it.
- No backup workflow was present in the repository.

Inspect cron-job.org execution history for the week before the Supabase pause and verify both the HTTP response and the associated GitHub workflow runs. The scraper workflow's green status is not a database health check: several scraper DB helper errors are logged and returned as false/null without failing the workflow.

## Supabase activity monitor

`.github/workflows/supabase-monitor.yml` calls the Supabase Data API endpoint for `listings` three times daily. It uses `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` already referenced by the scraper workflow. Each request has an 8-second abort timeout and at most three attempts, with bounded waits between attempts. It logs only status, attempt count, and elapsed time. A final failure sends a short Telegram alert using `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID`, then fails the Actions run.

This is real user-facing Data API activity, but Supabase does not publish a fixed inactivity threshold and explicitly does not guarantee that a particular request cadence prevents pausing. GitHub scheduled workflows can be delayed; public repositories can have schedules disabled after 60 days without repository activity. Confirm that the monitor workflow is enabled and has successful runs. The existing cron-job.org settings are inaccessible from this repository; if needed, configure a second cron job there to dispatch `supabase-monitor.yml` using the same GitHub workflow-dispatch arrangement already used for the scraper.

## Weekly export

`.github/workflows/supabase-backup.yml` runs weekly (and supports `workflow_dispatch`). It requires the repository to be private before it will export anything, writes SQL files only to the runner's temporary directory, suppresses the CLI's stderr to avoid printing connection details, creates and verifies a gzip archive and SHA-256 file, then uploads a GitHub Actions artifact for 14 days. Compressed archives over 100 MiB are rejected. Backups are not committed to the Git tree.

Required Actions secrets:

- `SUPABASE_DB_URL` — PostgreSQL connection string including the database password. Add it only as a GitHub Actions secret; do not paste it into repository files or logs. A Supavisor session-pooler URL may be needed if the runner cannot use the direct IPv6 connection.
- Existing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ADMIN_CHAT_ID` must be configured in repository Actions secrets for monitoring, cleanup preview, and failure notifications.

The job exports roles, schema, and SQL data with the Supabase CLI. Supabase's CLI filtering excludes managed `auth` and `storage` schemas and storage objects. This backup covers the app's public tables, including `listings` and `listing_price_history`; it is a data safety copy, not a complete Supabase Auth/Storage project clone.

GitHub Free currently includes 500 MB Actions artifact storage shared with GitHub Packages and 2,000 private-repository Actions minutes. The workflow caps each archive at 100 MiB and retains it for 14 days, but existing artifact/package usage is unknown. Check Actions storage and billing settings before enabling the workflow, and set the spending limit to $0 if any paid overage is configured. Public-repository standard runner minutes are free, but this workflow intentionally refuses to upload listing data from a public repository.

Download the latest successful artifact from Actions, then verify and unpack it:

```bash
sha256sum -c supabase-backup.sha256
tar -xzf supabase-backup.tar.gz
cd supabase-backup
```

To restore into a new/staging Supabase project (not the live project), use the target database URL and the official CLI restore sequence:

```bash
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$TARGET_DB_URL"
```

Test restoration before relying on a backup. Resuming a project paused for inactivity is normally simpler: use Supabase Dashboard → Resume project. Supabase's current guide says paused project data/settings are retained and the project can be resumed within one year.

## Listing retention: prepared, disabled by default

Apply `supabase/17_listing_retention.sql` manually only after reviewing it. It adds nullable `listings.published_at`, a preview RPC, a batch purge RPC, and count-only run history. It does not backfill from `created_at` or `last_seen_at`, schedule a deletion job, or delete records.

The scraper now normalizes only unambiguous ISO dates/timestamps, `DD.MM.YYYY`, and recognized Russian/Uzbek/English relative dates. Missing, unknown, invalid, and unsupported text remains NULL. Existing rows are not backfilled automatically; they remain ineligible until a later scrape supplies a trustworthy date.

Preview candidates use exactly:

```sql
published_at IS NOT NULL
AND published_at < now() - make_interval(days => 14) -- or 7
```

The preview returns total count and up to 20 examples containing only listing ID, source, deal type, and publication date. Purge is limited to 200 rows per weekly run, takes a transaction advisory lock, and refuses to run without explicit backup confirmation. The weekly export must upload successfully before the cleanup steps are even considered.

Deletion from `listings` activates the existing `listing_price_history.listing_id ON DELETE CASCADE`. The full external backup artifact is therefore the pre-deletion archive for both the listing and its price history; it is restorable only as a database backup, not a one-click per-listing restore.

Cleanup remains disabled unless both GitHub Actions repository variables are set:

- `ENABLE_LISTING_RETENTION_PREVIEW=true` — after applying migration 17, this enables weekly dry-run preview logging.
- `ENABLE_LISTING_RETENTION_CLEANUP=true` — enable only after reviewing real preview output and separately approving physical deletion.
- Optional `LISTING_RETENTION_DAYS=7` or `14`; if unset, code defaults to 14. Invalid values fail closed.

If these variables are unset, backup still runs, but cleanup is skipped. The migration has not been applied and these variables have not been changed by this work. Turn preview/cleanup off and wait for any running backup workflow to finish before applying database migrations.
