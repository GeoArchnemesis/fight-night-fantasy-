-- ============================================================
--  leaderboard_view_avatars.sql — LittleMoreUpdates.pdf p2
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor.
--
--  Bug: an uploaded avatar photo never showed on the leaderboard — it
--  always fell back to the emoji icon. Root cause: leaderboard_view
--  only ever selected id/nick/icon/score/verified, so the frontend had
--  no avatar_url/avatar_type to render even though it already knows
--  how (navAvaHtml() in app.js/f1-app.js/nba-app.js/football-app.js
--  already prefers avatar_url when avatar_type='photo', for the nav
--  bar — the leaderboard rows just never got those two fields).
--
--  Confirmed current definition (Giorgi, via Supabase SQL editor):
--    select id, nick, icon, score,
--           phone is not null or telegram is not null as verified
--    from users;
--
--  This CREATE OR REPLACE VIEW keeps those five columns' names, order
--  and definitions byte-for-byte identical (required — Postgres
--  refuses to CREATE OR REPLACE VIEW if an existing column's name,
--  order or type changes) and only appends avatar_url/avatar_type at
--  the end. Still a plain unfiltered select over users — that's what
--  makes the leaderboard readable at all while users' own RLS stays
--  restrictive — nothing about the view's access pattern changes.
--
--  No new exposure: avatar_url/avatar_type are already public via
--  get_public_profile (profile_redesign.sql / profile_updates.sql) and
--  the avatars live in a public-read storage bucket.
--
--  Scope: this view only. Nothing here touches any table, grant, RLS
--  policy, or settlement/balance/ticket/cron logic.
-- ============================================================

create or replace view public.leaderboard_view as
select id,
       nick,
       icon,
       score,
       (phone is not null or telegram is not null) as verified,
       avatar_url,
       avatar_type
from users;
