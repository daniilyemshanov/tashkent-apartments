# Миграции Supabase

1. `schema.sql` — базовая схема, применяется первой на новом проекте.
2. `01_...sql` → `13_...sql` — миграции в хронологическом порядке
   (по номеру в имени файла). Применять по порядку, от меньшего номера
   к большему, через SQL Editor.

Если добавляете новую миграцию — называйте её следующим номером
(`14_что_то.sql`), чтобы порядок применения оставался очевидным.


17. `17_listing_retention.sql` — adds a normalized publication date and guarded dry-run/purge RPCs. It does not schedule or execute deletion.

Listing retention is coordinated by `.github/workflows/supabase-backup.yml`: it exports and uploads a private, verified backup first, previews candidates, and only purges when the repository variable `ENABLE_LISTING_RETENTION_CLEANUP=true` is explicitly set. `LISTING_RETENTION_DAYS` accepts `7` or `14` (default 14). Purge batches are capped at 200 listings. The cutoff uses only non-null `listings.published_at`; `created_at` and `last_seen_at` are never substituted. `listing_price_history` is removed by its declared `ON DELETE CASCADE` only after the full backup artifact succeeds.

18. `18_storage_diet.sql` — adds `public.daily_cleanup()`, called once a day by `.github/workflows/daily-cleanup.yml`: clears `raw_text` (agent listings at once, others after 7 days), trims `price_history` to 30 entries and deletes listings older than 14 days (agent ones: 30). Listings the team worked on (contacted / assigned / notes / flagged) are never deleted. Dry run by default; real deletion needs the repository variable `DAILY_CLEANUP_LIVE=true`. See `docs/storage-diet.md`. It is independent of the weekly retention flow from migration 17 — use one or the other, not both.
