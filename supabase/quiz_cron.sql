-- ============================================================
--  quiz_cron.sql - server-side sweep for PvP rooms nobody is left to finish
--  NOT APPLIED. Nothing in this repo runs this file - Giorgi reviews it,
--  then pastes the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and runs it himself. Run this AFTER
--  supabase/quiz_presence.sql - this file calls public.sweep_quiz_room and
--  reuses its two timing constants, both defined there. Safe to re-run top
--  to bottom.
--
--  pg_cron on Supabase is usually a toggle, not a plain CREATE EXTENSION -
--  the guarded create below is attempted first since it is harmless to
--  rerun, but if it errors with a permission problem, that means this
--  project's pg_cron has to be turned on once from the dashboard instead:
--  Database, Extensions, search for pg_cron, enable it, then run the rest
--  of this file (the extension statement is fine to just skip at that
--  point - everything after it does not depend on how pg_cron got turned
--  on).
--
--  THE PROBLEM:
--  public.sweep_quiz_room(p_room_id uuid) (quiz_presence.sql) already does
--  the right thing to one room: it records a wrong answer for every
--  question whose deadline plus grace has passed with no answer row,
--  marks those players finished, and flips the room to 'finished' once
--  everyone is. It only ever runs from inside submit_quiz_answer and
--  get_quiz_results though, both called by a living client. If every
--  player in a room closes their browser while it is still 'active',
--  nothing is left to call either RPC, sweep_quiz_room never runs for
--  that room, and it stays 'active' forever. Rooms still 'waiting' are
--  already expired by join_quiz_room after 30 minutes (quiz_pvp.sql), so
--  they are not part of this file.
--
--  THE FIX:
--  public.sweep_abandoned_quiz_rooms(), below, finds every 'active' room
--  whose last question's deadline plus grace has already passed and calls
--  sweep_quiz_room on each one - the exact same function the two RPCs
--  already call, so an abandoned room is finished through the identical
--  path a live player's own client would have driven it through. A
--  pg_cron job runs this once a minute so it keeps happening with nobody
--  there.
--
--  VERIFIED AGAINST:
--   - supabase/quiz_pvp.sql:104-119 - quiz_rooms columns (id, status,
--     started_at, questions), confirming the select below.
--   - supabase/quiz_presence.sql:80-86 - quiz_pvp_question_seconds() and
--     quiz_pvp_forfeit_grace_seconds(), reused here rather than
--     repeating 30/15.
--   - supabase/quiz_presence.sql:92-159 (sweep_quiz_room) - in particular:
--     line 105, the "select ... for update" row lock, which is what makes
--     a cron sweep and a real submit_quiz_answer call racing on the same
--     room safe (one blocks on the lock, then sees the row the other
--     already changed); line 107, the "status <> 'active'" early return,
--     which makes a second sweep of an already-finished room a no-op;
--     lines 120-123, the per-question deadline formula this file's own
--     selection condition is written to match for the last question
--     (v_qi = v_total - 1, i.e. (v_qi + 1) = v_total); lines 125-129, the
--     "on conflict (room_id, player_id, question_index) do nothing"
--     insert, confirming two overlapping sweeps can't double-insert or
--     clobber a real answer; and line 156, the "status <> 'finished'"
--     guard on the final update, confirming re-running sweep_quiz_room on
--     an already-finished room changes nothing.
-- ============================================================


-- ============================================================
-- 1) EXTENSION - pg_cron. Harmless to rerun; see the dashboard note above
--    if this errors with a permission problem.
-- ============================================================
create extension if not exists pg_cron;


-- ============================================================
-- 2) FUNCTION - sweep_abandoned_quiz_rooms (NEW)
--    Not for client use (no grant to anon/authenticated) - only the cron
--    job below calls it. Never deletes a room or a player row; the actual
--    work (forfeit inserts, finished_at, status) is entirely
--    sweep_quiz_room's, called once per abandoned room found.
-- ============================================================
create or replace function public.sweep_abandoned_quiz_rooms()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_room record;
  v_count int := 0;
begin
  for v_room in
    select id from public.quiz_rooms
    where status = 'active'
      and started_at is not null
      and now() > started_at
        + jsonb_array_length(questions) * make_interval(secs => public.quiz_pvp_question_seconds())
        + make_interval(secs => public.quiz_pvp_forfeit_grace_seconds())
  loop
    perform public.sweep_quiz_room(v_room.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;


-- ============================================================
-- 3) SCHEDULE - once a minute, under a fixed job name. Unschedule any
--    existing job with that name first, so running this file twice does
--    not create a second copy of it.
-- ============================================================
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sweep_abandoned_quiz_rooms') then
    perform cron.unschedule('sweep_abandoned_quiz_rooms');
  end if;
end;
$$;

select cron.schedule(
  'sweep_abandoned_quiz_rooms',
  '* * * * *',
  $$select public.sweep_abandoned_quiz_rooms();$$
);


-- ============================================================
-- OFF SWITCH - uncomment and run to stop the job without dropping the
-- function it calls.
-- ============================================================
-- select cron.unschedule('sweep_abandoned_quiz_rooms');
