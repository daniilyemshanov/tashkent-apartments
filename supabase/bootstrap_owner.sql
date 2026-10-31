-- Run only after the owner has requested a magic link and confirmed the email.
-- Replace the marker with that exact confirmed email, then run this query once.
-- The function rejects unconfirmed/nonexistent emails and refuses to run if
-- team_members already contains any row. It does not create an Auth user.
select public.bootstrap_first_owner('REPLACE_WITH_REAL_CONFIRMED_EMAIL');