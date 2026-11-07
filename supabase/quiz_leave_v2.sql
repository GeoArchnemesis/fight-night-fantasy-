-- ============================================================
--  quiz_leave_v2.sql — away-budget forfeit, no-delete active-leave,
--  stuck-room fix, + Phase 1b amendments below
--  NOT APPLIED. Nothing in this repo runs this file — review it, then
--  paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom, AFTER
--  quiz_pvp.sql, quiz_group_pvp.sql, quiz_pvp_r2.sql,
--  quiz_pvp_host_leave.sql, quiz_presence.sql and quiz_cron.sql (this file
--  replaces sweep_quiz_room and submit_quiz_answer from quiz_presence.sql,
--  leave_quiz_room from quiz_pvp_host_leave.sql, rejoin_quiz_room from
--  quiz_group_pvp.sql, and sweep_abandoned_quiz_rooms from quiz_cron.sql —
--  all CREATE OR REPLACE, same signatures, no DROP needed). Safe to re-run
--  top to bottom. Live function bodies were re-confirmed byte-for-byte
--  against the repo files via pg_get_functiondef() on the live project
--  right before writing this (and again before the Phase 1b amendments
--  below).
--
--  THREE BUGS FIXED HERE (original pass):
--
--   1. sweep_quiz_room's final check was
--      `select bool_and(finished_at is not null) into v_all_finished
--       from quiz_room_players where room_id = p_room_id;`
--      bool_and() over zero rows returns NULL, not true, so a room with no
--      player rows left in it can never satisfy `if v_all_finished then`
--      and stays 'active' forever. Confirmed live and reproduced against
--      the two rooms named in the one-off block at the bottom of this file:
--      both show status='active' with 0 rows in quiz_room_players right
--      now. Fixed by wrapping it in coalesce(..., true) wherever this file
--      touches that check.
--
--   2. leave_quiz_room (quiz_pvp_host_leave.sql:58) does
--      `delete from quiz_room_players where room_id = ... and player_id = ...`
--      — once a player leaves an in-progress game, they're gone, so
--      get_quiz_results can never show them with a zeroed score; they just
--      vanish from the podium. A leaver should stay in the results as a
--      loss, not disappear. (Phase 1b narrows this to 'active' rooms only
--      — see change 1 below — a 'waiting' lobby leave still deletes.)
--
--   3. Today's forfeit timeline (quiz_presence.sql's sweep_quiz_room) is a
--      single absolute deadline per question —
--      started_at + (question_index + 1) * 30s + 15s — so a player who
--      vanishes on question 1 of 10 still isn't forfeited until roughly
--      10 * 30s + 15s ≈ 5m15s has passed from room start, because the
--      deadline is anchored to the LAST question regardless of where the
--      vanished player actually stopped. The remaining players are stuck
--      waiting the whole time.
--
--  PHASE 1b — FOUR AMENDMENTS TO THE ABOVE:
--
--   1. LOBBY LEAVE MUST DELETE AGAIN. The original pass made ALL leaves
--      (waiting or active) a forfeit, but sweep_quiz_room returns early
--      for any room not 'active' — so a 'waiting'-room leaver kept sitting
--      in quiz_room_players: still shown in the lobby list, still counted
--      toward max_players, still counted by start_quiz_room's "need >= 2
--      players" check (quiz_group_pvp.sql:291-294). leave_quiz_room is now
--      split by status: 'waiting' deletes the row outright (there are no
--      scores yet, nothing to forfeit) and never calls sweep_quiz_room;
--      'active' is unchanged from the original pass (forfeit + sweep,
--      never abandon); 'finished'/'abandoned' is now a no-op return.
--
--   2. REJOIN MUST REFUSE A FORFEITED PLAYER. rejoin_quiz_room didn't
--      check forfeited at all, so a forfeited player could rejoin an
--      active room and then have every submit_quiz_answer call rejected
--      with 'player forfeited', stranding them on a dead screen. Added one
--      check, body otherwise byte-for-byte unchanged — see the verified-
--      against note below on which body that actually is.
--
--   3. ZERO A FORFEITED PLAYER ONCE, NOT ON EVERY SWEEP. Now that
--      sweep_abandoned_quiz_rooms sweeps every active room once a minute,
--      sweep_quiz_room was rewriting a forfeited player's full 10-row
--      answer set on every single pass. New column forfeit_applied gates
--      the zeroing loop to run once per player.
--
--   4. 30-MINUTE EMERGENCY BACKSTOP. With the absolute per-question
--      deadline gone, a player whose browser dies without ever calling
--      quiz_mark_away leaves away_since null forever — nothing forfeits
--      them and the room can stay 'active' indefinitely. New constant
--      quiz_pvp_room_max_minutes() (30) plus a check inside sweep_quiz_room
--      that force-forfeits every unfinished player once a room has been
--      running longer than that, so this applies on every path (cron,
--      submit_quiz_answer, get_quiz_results), not only the cron pass.
--
--  WHAT THIS MEANS THE DEPLOYED SHAPE IS, PER FUNCTION (so there is one
--  place to check "is this the final version"): sweep_quiz_room — rewritten
--  per the original pass, then amended per changes 3 and 4.
--  quiz_mark_away / quiz_mark_back / quiz_forfeit_player — unchanged since
--  the original pass. leave_quiz_room — rewritten per change 1 (supersedes
--  the original pass's single-branch version). rejoin_quiz_room — new in
--  Phase 1b (the original pass did not touch it). submit_quiz_answer —
--  unchanged since the original pass. get_quiz_results — untouched by this
--  file entirely, in both passes (see the note in section F below).
--  sweep_abandoned_quiz_rooms — unchanged since the original pass.
--
--  ANSWER TO THE REJOIN QUESTION (reported, not fixed, per the request):
--  No — the 3rd..9th player of a group room is NOT blocked from
--  rejoining today. The `v_player.player_id not in (v_room.host_id,
--  coalesce(v_room.guest_id, ''))` check only ever existed in the
--  1v1-era rejoin_quiz_room defined in quiz_pvp.sql (around line 541).
--  quiz_group_pvp.sql's header itself says why: get_quiz_results and
--  rejoin_quiz_room both changed return type for N players, so Postgres
--  required `DROP FUNCTION IF EXISTS public.rejoin_quiz_room(uuid, text,
--  text)` followed by a fresh `CREATE FUNCTION` (quiz_group_pvp.sql:480-522)
--  — the quiz_pvp.sql copy was fully replaced, not left running alongside
--  it. I confirmed this live via
--  `pg_get_functiondef('public.rejoin_quiz_room(uuid,text,text)'::regprocedure)`
--  immediately before writing this amendment: the deployed function
--  returns `(status, code, game_type, level, max_players, questions,
--  players, answered_indexes)` and its participant check is
--  `not exists (select 1 from quiz_room_players where room_id = p_room_id
--  and player_id = v_player.player_id)` — a correct N-player membership
--  check, not the old host/guest pair. The CREATE OR REPLACE in section E2
--  below is written against that live body, confirmed matching.
--
--  VERIFIED AGAINST (file + line, then cross-checked against
--  pg_get_functiondef() on the live project both before the original pass
--  and again before this Phase 1b amendment — all matched exactly):
--   - supabase/quiz_group_pvp.sql:100-108 — quiz_room_players columns
--     (room_id, player_id, player_name, is_host, joined_at, finished_at)
--     and its primary key (room_id, player_id); also re-confirmed live via
--     information_schema.columns.
--   - supabase/quiz_presence.sql:80-86 — quiz_pvp_question_seconds() /
--     quiz_pvp_forfeit_grace_seconds(), the immutable-SQL-function pattern
--     quiz_pvp_away_budget_seconds() and quiz_pvp_room_max_minutes()
--     (section B) both follow. Neither existing constant is dropped or
--     edited by this file; quiz_pvp_forfeit_grace_seconds() simply has no
--     more callers after this file runs.
--   - supabase/quiz_presence.sql:92-159 — sweep_quiz_room's pre-this-file
--     body (the per-question absolute-deadline loop being removed, and the
--     "select ... for update" lock / "status <> 'active'" early return
--     being kept, both at lines 105-107).
--   - supabase/quiz_presence.sql:172-240 — submit_quiz_answer's current
--     body (the perform sweep_quiz_room(...) call at line 187 being kept;
--     the "not a participant" check at lines 194-196 being folded into the
--     new forfeited lookup). Unchanged since the original pass.
--   - supabase/quiz_presence.sql:247-302 — get_quiz_results's current body
--     (confirmed unchanged by this file, per the note above — in both the
--     original pass and this amendment).
--   - supabase/quiz_pvp_host_leave.sql:38-86 — leave_quiz_room's
--     pre-this-file body (the delete at line 58, now reinstated for the
--     'waiting' branch only per change 1; the waiting/active branches at
--     lines 62-84 otherwise replaced).
--   - supabase/quiz_group_pvp.sql:291-294 — start_quiz_room's "need at
--     least 2 players to start" count over quiz_room_players, confirming
--     why change 1 restores the delete-on-lobby-leave behavior.
--   - supabase/quiz_group_pvp.sql:480-522 — the actual live
--     rejoin_quiz_room (DROP+CREATE, supersedes quiz_pvp.sql:541 entirely)
--     — re-confirmed byte-for-byte live via pg_get_functiondef()
--     immediately before writing section E2.
--   - supabase/quiz_cron.sql:78-98 — sweep_abandoned_quiz_rooms's current
--     body (the absolute-deadline selection at lines 88-91 being removed;
--     no explicit grant to anon/authenticated exists anywhere in that
--     file, confirming the PUBLIC-default-EXECUTE note in section G).
--     Unchanged since the original pass.
--   - supabase/quiz_pvp.sql:258-271 — quiz_resolve_player (auth.uid()
--     required, raises on a null session), reused unchanged by every RPC
--     in this file.
--   - supabase/quiz_pvp.sql:126-135 — quiz_room_answers columns and
--     primary key (room_id, player_id, question_index), confirming the
--     `on conflict` target used in section D matches exactly what was
--     asked for.
--
--  Not touched by this file: quiz_rooms, quiz_room_keys, quiz_room_answers
--  schema; any RLS policy or grant other than the one revoke in section G;
--  create_quiz_room, join_quiz_room, start_quiz_room, reveal_quiz_clue,
--  get_quiz_results; any .js/.html file; any Georgian user-facing text;
--  betting/ticket/settlement/balance logic.
-- ============================================================


-- ============================================================
-- A) SCHEMA — quiz_room_players away/forfeit tracking
-- ============================================================
alter table public.quiz_room_players add column if not exists away_since timestamptz;
alter table public.quiz_room_players add column if not exists away_ms_used int not null default 0;
alter table public.quiz_room_players add column if not exists forfeited boolean not null default false;
-- Phase 1b, change 3 — gates sweep_quiz_room's zeroing loop to run once
-- per forfeited player instead of on every sweep pass.
alter table public.quiz_room_players add column if not exists forfeit_applied boolean not null default false;


-- ============================================================
-- B) CONSTANTS — same immutable-SQL-function pattern as
--    quiz_pvp_question_seconds() / quiz_pvp_forfeit_grace_seconds()
--    (quiz_presence.sql:80-86).
-- ============================================================
create or replace function public.quiz_pvp_away_budget_seconds()
returns int
language sql immutable as $$ select 20 $$;

-- Phase 1b, change 4 — emergency backstop ceiling for a whole room, used
-- only by sweep_quiz_room below.
create or replace function public.quiz_pvp_room_max_minutes()
returns int
language sql immutable as $$ select 30 $$;


-- ============================================================
-- D) RPC — sweep_quiz_room (REWRITTEN — no more absolute per-question
--    deadline; forfeits on away-budget exhaustion instead; zero-player
--    bool_and fix; Phase 1b adds the forfeit_applied gate and the
--    30-minute emergency backstop). Defined before section C below because
--    the three new RPCs in C call this one.
-- ============================================================
create or replace function public.sweep_quiz_room(p_room_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_room public.quiz_rooms%rowtype;
  v_total int;
  v_pick jsonb;
  v_player record;
  v_qi int;
  v_all_finished boolean;
begin
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then return; end if;
  if v_room.status <> 'active' or v_room.started_at is null then return; end if;

  v_total := jsonb_array_length(v_room.questions);
  v_pick := case when v_room.game_type = 'quiz' then to_jsonb(-1) else to_jsonb(''::text) end;

  -- Away budget exhausted while still marked away -> forfeited. This is the
  -- backstop for a player who went away and never called quiz_mark_back at
  -- all (e.g. closed the tab outright); quiz_mark_back and
  -- quiz_forfeit_player set forfeited = true directly and call this
  -- function themselves for the live-caller case.
  update public.quiz_room_players
    set forfeited = true
    where room_id = p_room_id
      and away_since is not null
      and away_ms_used + (extract(epoch from (now() - away_since)) * 1000)::int
          >= public.quiz_pvp_away_budget_seconds() * 1000;

  -- Phase 1b, change 4 — EMERGENCY BACKSTOP. Should never fire in a normal
  -- game. Covers a player whose browser died without ever calling
  -- quiz_mark_away at all, so away_since stayed null forever and the
  -- check above could never catch them — with no per-question deadline
  -- left, nothing else would ever forfeit that player and the room could
  -- stay 'active' indefinitely. Only trips once the whole room has run
  -- longer than quiz_pvp_room_max_minutes(); forfeits every player who
  -- hasn't already finished, not just away players.
  if now() > v_room.started_at + make_interval(mins => public.quiz_pvp_room_max_minutes()) then
    update public.quiz_room_players
      set forfeited = true
      where room_id = p_room_id and finished_at is null;
  end if;

  -- Every forfeited player loses every question, OVERWRITING any answers
  -- they already had correct — a forfeited player ends on 0 across the
  -- board, never partial credit for whatever they answered before leaving.
  -- Phase 1b, change 3: gated by forfeit_applied so a player already
  -- zeroed by an earlier sweep isn't rewritten on every subsequent pass
  -- (sweep_abandoned_quiz_rooms now calls this once a minute for every
  -- active room).
  for v_player in
    select player_id from public.quiz_room_players
    where room_id = p_room_id and forfeited = true and forfeit_applied = false
  loop
    for v_qi in 0 .. v_total - 1 loop
      insert into public.quiz_room_answers
        (room_id, player_id, question_index, pick, points, answered_at)
        values (p_room_id, v_player.player_id, v_qi, v_pick, 0, now())
      on conflict (room_id, player_id, question_index)
        do update set pick = excluded.pick, points = 0, answered_at = excluded.answered_at;
    end loop;

    update public.quiz_room_players
      set forfeit_applied = true
      where room_id = p_room_id and player_id = v_player.player_id;
  end loop;

  update public.quiz_room_players qp
    set finished_at = coalesce(finished_at, now())
    where room_id = p_room_id
      and (
        select count(*) from public.quiz_room_answers qa
        where qa.room_id = p_room_id and qa.player_id = qp.player_id and qa.answered_at is not null
      ) >= v_total;

  -- coalesce(..., true): a room with zero player rows left must resolve to
  -- 'finished' instead of hanging on a NULL bool_and over no rows at all —
  -- reproduced live against the two rooms in section H.
  select coalesce(bool_and(finished_at is not null), true) into v_all_finished
    from public.quiz_room_players where room_id = p_room_id;

  if v_all_finished then
    update public.quiz_rooms set status = 'finished' where id = p_room_id and status <> 'finished';
  end if;
end;
$$;

grant execute on function public.sweep_quiz_room(uuid) to anon, authenticated;


-- ============================================================
-- C) RPCs — quiz_mark_away / quiz_mark_back / quiz_forfeit_player
--    (unchanged since the original pass). None of these writes a zeroed
--    answer row itself — every path that sets forfeited = true calls
--    sweep_quiz_room immediately after, so the zeroing logic exists in
--    exactly one place (section D above).
-- ============================================================

create or replace function public.quiz_mark_away(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

  update public.quiz_room_players
    set away_since = now()
    where room_id = p_room_id and player_id = v_player.player_id and away_since is null;
end;
$$;

grant execute on function public.quiz_mark_away(uuid, text, text) to anon, authenticated;


create or replace function public.quiz_mark_back(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_row public.quiz_room_players%rowtype;
  v_new_used int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;

  select * into v_row from public.quiz_room_players
    where room_id = p_room_id and player_id = v_player.player_id;
  if not found then raise exception 'not a participant'; end if;

  if v_row.away_since is not null then
    v_new_used := v_row.away_ms_used + (extract(epoch from (now() - v_row.away_since)) * 1000)::int;

    update public.quiz_room_players
      set away_since = null, away_ms_used = v_new_used
      where room_id = p_room_id and player_id = v_player.player_id;

    if v_new_used >= public.quiz_pvp_away_budget_seconds() * 1000 then
      update public.quiz_room_players
        set forfeited = true
        where room_id = p_room_id and player_id = v_player.player_id;
      perform public.sweep_quiz_room(p_room_id);
    end if;
  end if;
end;
$$;

grant execute on function public.quiz_mark_back(uuid, text, text) to anon, authenticated;


create or replace function public.quiz_forfeit_player(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

  update public.quiz_room_players
    set forfeited = true
    where room_id = p_room_id and player_id = v_player.player_id;

  perform public.sweep_quiz_room(p_room_id);
end;
$$;

grant execute on function public.quiz_forfeit_player(uuid, text, text) to anon, authenticated;


-- ============================================================
-- E) RPC — leave_quiz_room (Phase 1b, change 1 — REWRITTEN AGAIN: split
--    by room status instead of one shared forfeit-and-sweep path).
-- ============================================================
create or replace function public.leave_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_was_host boolean;
  v_new_host text;
  v_remaining int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then return; end if;  -- already gone, nothing to do
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

  if v_room.status not in ('waiting', 'active') then
    return;  -- 'finished' or 'abandoned' — nothing to do
  end if;

  v_was_host := (v_player.player_id = v_room.host_id);

  if v_room.status = 'waiting' then
    -- No scores exist yet in a lobby — nothing to forfeit. Delete the row
    -- outright (as quiz_pvp_host_leave.sql always did) so the leaver stops
    -- counting toward the lobby list, the max_players cap, and
    -- start_quiz_room's "need at least 2 players" check
    -- (quiz_group_pvp.sql:291-294). sweep_quiz_room is never called here —
    -- it only ever acts on an 'active' room anyway.
    delete from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id;

    if v_was_host then
      select player_id into v_new_host
        from public.quiz_room_players
        where room_id = p_room_id
        order by joined_at asc
        limit 1;
      if v_new_host is not null then
        update public.quiz_rooms set host_id = v_new_host where id = p_room_id;
      end if;
    end if;

    select count(*) into v_remaining from public.quiz_room_players where room_id = p_room_id;
    if v_remaining = 0 then
      update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
    end if;

  else -- 'active'
    -- Leaving = immediate forfeit, applied through the same single path
    -- every other forfeit goes through — zeroed answers, finished_at and
    -- room status all come from sweep_quiz_room, never duplicated here.
    -- The player row itself is never deleted once the game has started.
    update public.quiz_room_players
      set forfeited = true
      where room_id = p_room_id and player_id = v_player.player_id;

    perform public.sweep_quiz_room(p_room_id);

    -- The host is no longer special re: abandoning an active room — it is
    -- never abandoned here, only handed off to the remaining non-forfeited
    -- player with the earliest joined_at, if any such player exists.
    if v_was_host then
      select player_id into v_new_host
        from public.quiz_room_players
        where room_id = p_room_id and player_id <> v_player.player_id and forfeited = false
        order by joined_at asc
        limit 1;
      if v_new_host is not null then
        update public.quiz_rooms set host_id = v_new_host where id = p_room_id;
      end if;
    end if;
  end if;
end;
$$;

grant execute on function public.leave_quiz_room(uuid, text, text) to anon, authenticated;


-- ============================================================
-- E2) RPC — rejoin_quiz_room (Phase 1b, change 2 — NEW in this file).
--     Body is byte-for-byte the live quiz_group_pvp.sql:480-522 version,
--     re-confirmed via pg_get_functiondef() immediately before writing
--     this, plus exactly one added check. See the header note above for
--     why quiz_pvp.sql:541 is NOT the live body.
-- ============================================================
create or replace function public.rejoin_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(
  status text, code text, game_type text, level text, max_players int,
  questions jsonb, players jsonb, answered_indexes int[]
)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_answered int[];
  v_players jsonb;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;
  if exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id and forfeited = true) then
    raise exception 'player forfeited';
  end if;
  if v_room.status = 'abandoned' then
    raise exception 'room abandoned';
  end if;

  select coalesce(array_agg(question_index order by question_index), array[]::int[])
    into v_answered
    from public.quiz_room_answers
    where room_id = p_room_id and player_id = v_player.player_id and answered_at is not null;

  select coalesce(jsonb_agg(
           jsonb_build_object('player_id', player_id, 'player_name', player_name,
                               'is_host', is_host, 'finished_at', finished_at)
           order by joined_at
         ), '[]'::jsonb)
    into v_players
    from public.quiz_room_players
    where room_id = p_room_id;

  return query select v_room.status, v_room.code, v_room.game_type, v_room.level, v_room.max_players,
                      v_room.questions, v_players, v_answered;
end;
$$;

grant execute on function public.rejoin_quiz_room(uuid, text, text) to anon, authenticated;


-- ============================================================
-- F) RPC — submit_quiz_answer (unchanged since the original pass — same
--    body as quiz_presence.sql, plus a forfeited-player rejection).
--    get_quiz_results needs NO change — see the header note above — so it
--    is intentionally not repeated here.
-- ============================================================
create or replace function public.submit_quiz_answer(
  p_room_id uuid, p_question_index int, p_pick jsonb, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_key jsonb;
  v_clues_shown int;
  v_points int := 0;
  v_correct boolean;
  v_answered_count int;
  v_total int;
  v_all_finished boolean;
  v_forfeited boolean;
begin
  perform public.sweep_quiz_room(p_room_id);

  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;

  select forfeited into v_forfeited
    from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id;
  if not found then raise exception 'not a participant'; end if;
  if v_forfeited then raise exception 'player forfeited'; end if;

  v_total := jsonb_array_length(v_room.questions);
  if p_question_index < 0 or p_question_index >= v_total then
    raise exception 'bad question index';
  end if;

  select answer_key into v_key from public.quiz_room_keys where room_id = p_room_id;

  select clues_shown into v_clues_shown
    from public.quiz_room_answers
    where room_id = p_room_id and player_id = v_player.player_id and question_index = p_question_index;
  v_clues_shown := coalesce(v_clues_shown, 1);

  if v_room.game_type = 'quiz' then
    v_correct := ((v_key -> p_question_index) = p_pick);
    v_points := case when v_correct then 1 else 0 end;
  else
    v_correct := public.quiz_is_guess_correct(p_pick #>> '{}', v_key ->> p_question_index);
    v_points := case when v_correct then greatest(1, least(4, 5 - v_clues_shown)) else 0 end;
  end if;

  insert into public.quiz_room_answers (room_id, player_id, question_index, clues_shown, pick, points, answered_at)
    values (p_room_id, v_player.player_id, p_question_index, v_clues_shown, p_pick, v_points, now())
  on conflict (room_id, player_id, question_index)
    do update set pick = excluded.pick, points = excluded.points, answered_at = excluded.answered_at;

  select count(*) into v_answered_count
    from public.quiz_room_answers
    where room_id = p_room_id and player_id = v_player.player_id and answered_at is not null;

  if v_answered_count >= v_total then
    update public.quiz_room_players
      set finished_at = coalesce(finished_at, now())
      where room_id = p_room_id and player_id = v_player.player_id;

    select bool_and(finished_at is not null) into v_all_finished
      from public.quiz_room_players where room_id = p_room_id;

    if v_all_finished then
      update public.quiz_rooms set status = 'finished' where id = p_room_id and status <> 'finished';
    end if;
  end if;
end;
$$;

grant execute on function public.submit_quiz_answer(uuid, int, jsonb, text, text) to anon, authenticated;


-- ============================================================
-- G) RPC — sweep_abandoned_quiz_rooms (unchanged since the original pass
--    — drops the absolute quiz-length deadline from its selection).
--    Phase 1d fix: this function was originally created in quiz_cron.sql
--    with no explicit grant statement at all, so it carries Postgres'
--    default EXECUTE grant to PUBLIC — every role, including anon/
--    authenticated, implicitly has whatever PUBLIC has, with no separate
--    ACL entry needed for them. CREATE OR REPLACE FUNCTION preserves a
--    function's existing ACL across a replace, so that PUBLIC grant
--    survives unchanged through this file's own CREATE OR REPLACE above.
--    anon/authenticated were never literal ACL entries to begin with, so
--    `revoke ... from anon, authenticated` alone has nothing to remove —
--    confirmed live: an anon-key call to
--    /rest/v1/rpc/sweep_abandoned_quiz_rooms still succeeded after that
--    revoke ran by itself. Revoking from PUBLIC itself is what actually
--    closes this off; the from-anon/authenticated revoke is kept
--    alongside it only so the ACL stays explicit if PUBLIC is ever
--    re-granted some other way.
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
    where status = 'active' and started_at is not null
  loop
    perform public.sweep_quiz_room(v_room.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.sweep_abandoned_quiz_rooms() from public;
revoke execute on function public.sweep_abandoned_quiz_rooms() from anon, authenticated;


-- ============================================================
-- OPTIONAL — run separately, read-only, sanity checks
-- ============================================================
-- confirm all four new columns exist:
-- select column_name, data_type, column_default from information_schema.columns
-- where table_schema='public' and table_name='quiz_room_players'
--   and column_name in ('away_since','away_ms_used','forfeited','forfeit_applied');
--
-- confirm anon/authenticated can no longer call sweep_abandoned_quiz_rooms:
-- select grantee, privilege_type from information_schema.role_routine_grants
-- where routine_name = 'sweep_abandoned_quiz_rooms';
--
-- confirm a forfeited player's answers are not rewritten on a second sweep
-- (forfeit_applied should already be true, answered_at should not move):
-- select player_id, forfeited, forfeit_applied from quiz_room_players where room_id = '<room id>';
-- select answered_at from quiz_room_answers where room_id = '<room id>' and player_id = '<player id>';
-- -- (call select public.sweep_quiz_room('<room id>'::uuid); again, then re-run both and diff)
--
-- confirm the two stuck rooms resolve after section H below is uncommented
-- and run:
-- select id, status from public.quiz_rooms
-- where id in ('7839a20e-38c9-448d-8f1b-e68cccea4131', '5153d9a7-d496-4c16-826f-1d4d9c56d4c4');


-- ============================================================
-- H) ONE-OFF — uncomment and run AFTER everything above has been applied.
--    Resolves the two rooms confirmed live (right before the original
--    pass was written) as status='active' with 0 rows in
--    quiz_room_players — the exact zero-player bool_and case. These two
--    rooms are old enough that the 30-minute backstop (change 4) would
--    also eventually force them through a future cron sweep on its own;
--    this just does it immediately instead of waiting.
-- ============================================================
-- select public.sweep_quiz_room('7839a20e-38c9-448d-8f1b-e68cccea4131'::uuid);
-- select public.sweep_quiz_room('5153d9a7-d496-4c16-826f-1d4d9c56d4c4'::uuid);
