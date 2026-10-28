-- ============================================================
--  monthly_badges automatic-award resolver
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor, after
--  supabase/monthly_badges_pending_awards.sql has already been run
--  (needs public.monthly_badge_images / public.monthly_badge_awards
--  to exist). Nothing here touches any other table, grant, RLS
--  policy, or settlement/balance/ticket/cron logic — this only reads
--  score_history (already read client-side by admin.html's
--  computeMonthTop3) and writes the two badge tables.
--
--  Mechanism (approved): an idempotent SECURITY DEFINER function,
--  resolve_monthly_badges(), called from EPJQI8FX/admin.html on every
--  admin-session load (regardless of which card is open) AND from an
--  explicit "resolve pending badges now" button on the badges card.
--  Deliberately NOT wired to any public page or GitHub Actions cron —
--  those are off-limits per the instructions this was written under.
--
--  Admin-only despite SECURITY DEFINER: the function checks
--  users.is_admin against auth.uid() itself and raises if the caller
--  isn't an admin, the same way this project's other privileged RPCs
--  (e.g. settle_nba_tickets) gate themselves — granting EXECUTE to
--  `authenticated` alone would NOT be enough on its own, since RLS is
--  bypassed inside a SECURITY DEFINER function; the in-function check
--  is the actual gate.
--
--  Idempotent: only touches monthly_badge_images rows where
--  resolved_at is null AND the period has fully elapsed in Tbilisi
--  time (UTC+4, no DST — same convention as tbilisiNow() in
--  admin.html and scripts/nba-auto.js). Each matching row is resolved
--  exactly once — resolved_at is set unconditionally (even when a
--  period had zero score_history activity, so it never sits pending
--  forever) — and award rows are inserted with ON CONFLICT DO NOTHING,
--  so calling this function repeatedly (every admin page load) is
--  always safe.
--
--  UFC-only for now: admin.html's badge sport selector currently only
--  offers 'ufc' (<select id="badgeSport"><option value="ufc">), and
--  score_history is itself a UFC-specific table (F1/NBA/football each
--  have their own f1_score_history / nba_score_history /
--  soccer_score_history, structurally different — soccer's is keyed
--  additionally by league). This function only knows how to compute a
--  winner for sport = 'ufc'; a monthly_badge_images row for any other
--  sport value is left untouched (resolved_at stays null) rather than
--  guessed at, since there's no admin UI path that could have created
--  one today. Extending to other sports is a separate task.
-- ============================================================

create or replace function public.resolve_monthly_badges()
returns table (resolved_count int, awarded_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_tbilisi timestamptz := now() + interval '4 hours';
  v_cur_year int := extract(year from v_tbilisi)::int;
  v_cur_month int := extract(month from v_tbilisi)::int;
  v_resolved_count int := 0;
  v_awarded_count int := 0;
  rec record;
  v_start timestamptz;
  v_end timestamptz;
  v_max_pts numeric;
  v_winner record;
begin
  select exists(
    select 1 from public.users where id = auth.uid() and is_admin = true
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'resolve_monthly_badges: admin only';
  end if;

  for rec in
    select *
    from public.monthly_badge_images
    where resolved_at is null
      and sport = 'ufc'
      and (period_year < v_cur_year or (period_year = v_cur_year and period_month < v_cur_month))
    order by period_year, period_month
  loop
    v_start := make_timestamptz(rec.period_year, rec.period_month, 1, 0, 0, 0, '+04:00');
    v_end := v_start + interval '1 month';

    select max(pts) into v_max_pts
    from (
      select user_id, sum(amount) as pts
      from public.score_history
      where created_at >= v_start and created_at < v_end
      group by user_id
      having sum(amount) > 0
    ) totals;

    if v_max_pts is not null then
      for v_winner in
        select user_id, sum(amount) as pts
        from public.score_history
        where created_at >= v_start and created_at < v_end
        group by user_id
        having sum(amount) = v_max_pts
      loop
        insert into public.monthly_badge_awards (badge_image_id, user_id)
        values (rec.id, v_winner.user_id)
        on conflict (badge_image_id, user_id) do nothing;
        v_awarded_count := v_awarded_count + 1;
      end loop;
    end if;

    update public.monthly_badge_images
    set resolved_at = now()
    where id = rec.id;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  return query select v_resolved_count, v_awarded_count;
end;
$$;

revoke all on function public.resolve_monthly_badges() from public;
grant execute on function public.resolve_monthly_badges() to authenticated;
-- Not granted to anon: badges are an admin-driven write path, same
-- posture as every other admin RPC in this project (anon never gets
-- EXECUTE on an admin-gated function, even when the function
-- self-checks — matches the GRANT pattern this repo already treats as
-- the known-good reference, see CLAUDE.md's GRANT bug note).
