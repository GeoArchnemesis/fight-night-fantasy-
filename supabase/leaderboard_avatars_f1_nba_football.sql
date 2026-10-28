-- ============================================================
--  leaderboard_avatars_f1_nba_football.sql — avatar photos global
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor.
--
--  Follow-up to supabase/leaderboard_view_avatars.sql (UFC's
--  leaderboard_view). That commit only fixed UFC — F1, NBA and
--  football have their OWN separate leaderboard sources
--  (f1_leaderboard_view, nba_leaderboard_view, get_football_leaderboard
--  RPC), none of which exposed avatar_url/avatar_type either, so an
--  uploaded photo still fell back to the emoji icon on those three
--  leaderboards. This file brings all three in line with UFC's.
--
--  Scope: these two views + one function only. Nothing here touches
--  any other table, grant, RLS policy, or settlement/balance/ticket/
--  cron logic — user_balances is only ever SELECTed here, never
--  written.
--
--  Definitions below are Giorgi's exact current definitions with only
--  avatar_url/avatar_type appended — nothing else changed, same
--  byte-for-byte-except-two-new-columns approach as leaderboard_view.
-- ============================================================


-- ============================================================
-- 1) f1_leaderboard_view — CREATE OR REPLACE (existing columns
--    unchanged, avatar_url/avatar_type appended)
-- ============================================================
create or replace view public.f1_leaderboard_view as
select u.id,
       u.nick,
       u.icon,
       coalesce(b.score, 0::numeric) as score,
       (u.phone is not null or u.telegram is not null) as verified,
       u.avatar_url,
       u.avatar_type
  from users u
  left join user_balances b on b.user_id = u.id and b.sport = 'f1'::text;


-- ============================================================
-- 2) nba_leaderboard_view — CREATE OR REPLACE (same shape)
-- ============================================================
create or replace view public.nba_leaderboard_view as
select u.id,
       u.nick,
       u.icon,
       coalesce(b.score, 0::numeric) as score,
       (u.phone is not null or u.telegram is not null) as verified,
       u.avatar_url,
       u.avatar_type
  from users u
  left join user_balances b on b.user_id = u.id and b.sport = 'nba'::text;


-- ============================================================
-- 3) get_football_leaderboard(text) — return type changes
--    (two columns appended to the TABLE return shape), so
--    CREATE OR REPLACE is refused by Postgres: this needs
--    DROP + CREATE. Dropping a function also drops its grants, so
--    this is a 3-step, capture-then-restore process rather than a
--    guess — same "don't assume" rule as the schema itself.
-- ============================================================

-- ---------- STEP A — run this ONE query by itself FIRST ----------
-- Paste just this SELECT alone, run it, and keep the result — it's
-- what step C below restores. (Not commented out: it's read-only and
-- harmless to run multiple times, but it must run and be captured
-- BEFORE step B's DROP, which is why it's a separate step here rather
-- than folded into one script run top-to-bottom blind.)
select grantee, privilege_type
from information_schema.role_routine_grants
where routine_schema = 'public' and routine_name = 'get_football_leaderboard'
order by grantee, privilege_type;

-- ---------- STEP B — drop + recreate ----------
drop function if exists public.get_football_leaderboard(text);

create or replace function public.get_football_leaderboard(p_league text)
 returns table(user_id uuid, nick text, score integer, icon text, verified boolean, avatar_url text, avatar_type text)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select u.id,
         u.nick,
         coalesce(b.score, 0)::int as score,
         u.icon,
         (u.phone is not null or u.telegram is not null) as verified,
         u.avatar_url,
         u.avatar_type
    from public.user_balances b
    join public.users u on u.id = b.user_id
   where b.sport = 'soccer_' || p_league
   order by coalesce(b.score, 0) desc
   limit 300;
$function$;

-- ---------- STEP C — restore the grants step A showed you ----------
-- Every public-facing leaderboard-reading function/view already in this
-- project grants EXECUTE/SELECT to both anon and authenticated (plain
-- leaderboard_view, get_quiz_room_player_avatars, etc.) — football-app.js
-- calls this RPC the same way those are called, so that's the
-- well-evidenced default below. I have NOT seen this function's actual
-- live grants (not in this repo, only live in Supabase), so: if step A's
-- output differs from exactly "anon: EXECUTE" + "authenticated: EXECUTE"
-- (e.g. it also lists service_role explicitly, or is missing one of
-- these), edit the line below to match step A's actual output before
-- running it — don't run it unexamined.
grant execute on function public.get_football_leaderboard(text) to anon, authenticated;
