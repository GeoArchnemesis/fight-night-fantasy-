-- ============================================================
--  quiz_presence.sql - server-side forfeit for PvP rooms a player
--  disappeared from
--  NOT APPLIED. Nothing in this repo runs this file - review it, then
--  paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom, AFTER
--  quiz_group_pvp.sql, quiz_pvp_r2.sql and quiz_pvp_host_leave.sql (in
--  that order - this file's CREATE OR REPLACE for get_quiz_results
--  carries forward the avatar columns quiz_pvp_r2.sql added, and
--  submit_quiz_answer is otherwise untouched since quiz_group_pvp.sql, so
--  it does not matter whether quiz_pvp_host_leave.sql has run yet, but
--  running it last keeps the deployment order linear). Safe to re-run
--  top to bottom.
--
--  THE PROBLEM:
--  PVP_TIME_PER_Q (ufc/quiz.js) gives each player 30 seconds per
--  question, but that deadline only exists in the browser - the server
--  never enforces it. The only automatic room expiry today is inside
--  join_quiz_room, and it only catches a room still 'waiting' after 30
--  minutes. An 'active' room whose player closed the tab never reaches
--  bool_and(finished_at is not null) on its own, so the remaining
--  players wait forever and get_quiz_results keeps raising 'room not
--  finished yet'.
--
--  THE FIX:
--  sweep_quiz_room(p_room_id), below, scans an 'active' room and, for
--  every player and every question whose 30-second deadline plus a
--  15-second grace period has passed with no answer row yet, inserts
--  the same timeout pick submitPvpTimeoutSilently() in ufc/quiz.js would
--  have sent (p_pick = -1 for game_type='quiz', '' for game_type='guess',
--  0 points - ufc/quiz.js:1368-1373), then applies the exact
--  "has this player finished" / "has everyone finished" logic
--  submit_quiz_answer already uses (quiz_group_pvp.sql, the "finish
--  check" block) so a swept player ends up with finished_at set and the
--  room flips to 'finished' under the same bool_and(...) rule as a
--  normal finish - never removed, always present in get_quiz_results
--  with whatever score (0 for every missed question) they'd earned.
--
--  It is called from the start of submit_quiz_answer and
--  get_quiz_results - the two RPCs every remaining player already calls
--  during and after a game - so no cron job or scheduled task is
--  needed. A player who is actually present is never affected: their
--  own client submits within 30 seconds, long before the 15-second
--  grace on top of that even starts.
--
--  Idempotent and concurrency-safe: it takes the same
--  `select ... for update` row lock on quiz_rooms the other RPCs take
--  before touching anything, and the forfeit insert uses the same
--  (room_id, player_id, question_index) primary key as every other
--  write to quiz_room_answers with `on conflict do nothing`, so two
--  overlapping sweeps (or a sweep racing a real late submission) can
--  never double-insert or clobber a real answer that already landed.
--
--  VERIFIED AGAINST:
--   - supabase/quiz_group_pvp.sql:342-408 (submit_quiz_answer) - the
--     "has this player finished" / "has everyone finished" block
--     reused here line-for-line is copied from there (v_answered_count
--     >= v_total -> set finished_at -> bool_and(...) -> status =
--     'finished').
--   - supabase/quiz_pvp_r2.sql:83-136 - the current body of
--     get_quiz_results (the one this file's CREATE OR REPLACE must
--     match, since it added icon/avatar_url/avatar_type).
--   - supabase/quiz_pvp.sql:126-135 - quiz_room_answers columns and
--     primary key (room_id, player_id, question_index), confirming the
--     on conflict target and that clues_shown/pick/points/answered_at
--     all accept the values this file inserts.
--   - ufc/quiz.js:24 (PVP_TIME_PER_Q = 30) and ufc/quiz.js:1368-1373
--     (submitPvpTimeoutSilently) - confirms the 30 second window and
--     that a timed-out pick is -1 (quiz) or "" (guess) with 0 points,
--     matching the v_pick/0 this file inserts.
-- ============================================================


-- ============================================================
-- 1) NAMED CONSTANTS - question time and forfeit grace, kept in sync
--    with PVP_TIME_PER_Q in ufc/quiz.js (currently 30). Wrapped as
--    immutable SQL functions since plain SQL has no file-scoped
--    constant; sweep_quiz_room below is the only caller.
-- ============================================================
create or replace function public.quiz_pvp_question_seconds()
returns int
language sql immutable as $$ select 30 $$;

create or replace function public.quiz_pvp_forfeit_grace_seconds()
returns int
language sql immutable as $$ select 15 $$;


-- ============================================================
-- 2) RPC - sweep_quiz_room (NEW)
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
  v_deadline timestamptz;
  v_answered_count int;
  v_all_finished boolean;
begin
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then return; end if;
  if v_room.status <> 'active' or v_room.started_at is null then return; end if;

  v_total := jsonb_array_length(v_room.questions);
  v_pick := case when v_room.game_type = 'quiz' then to_jsonb(-1) else to_jsonb(''::text) end;

  -- Insert a forfeit answer for every (player, question) pair whose
  -- deadline + grace has passed and that has no answer row yet. The
  -- primary key on quiz_room_answers plus "on conflict do nothing" makes
  -- this safe to run concurrently with a real submit_quiz_answer call
  -- for the same question.
  for v_player in
    select player_id from public.quiz_room_players where room_id = p_room_id
  loop
    for v_qi in 0 .. v_total - 1 loop
      v_deadline := v_room.started_at
        + (v_qi + 1) * make_interval(secs => public.quiz_pvp_question_seconds())
        + make_interval(secs => public.quiz_pvp_forfeit_grace_seconds());

      if now() > v_deadline then
        insert into public.quiz_room_answers
          (room_id, player_id, question_index, pick, points, answered_at)
          values (p_room_id, v_player.player_id, v_qi, v_pick, 0, now())
        on conflict (room_id, player_id, question_index) do nothing;
      end if;
    end loop;
  end loop;

  -- Same "has this player finished" / "has everyone finished" logic as
  -- submit_quiz_answer (quiz_group_pvp.sql), reused rather than
  -- reimplemented, applied for every player since a sweep can finish
  -- more than one player's last question in the same pass.
  for v_player in
    select player_id from public.quiz_room_players where room_id = p_room_id
  loop
    select count(*) into v_answered_count
      from public.quiz_room_answers
      where room_id = p_room_id and player_id = v_player.player_id and answered_at is not null;

    if v_answered_count >= v_total then
      update public.quiz_room_players
        set finished_at = coalesce(finished_at, now())
        where room_id = p_room_id and player_id = v_player.player_id;
    end if;
  end loop;

  select bool_and(finished_at is not null) into v_all_finished
    from public.quiz_room_players where room_id = p_room_id;

  if v_all_finished then
    update public.quiz_rooms set status = 'finished' where id = p_room_id and status <> 'finished';
  end if;
end;
$$;

grant execute on function public.sweep_quiz_room(uuid) to anon, authenticated;


-- ============================================================
-- 3) WIRE-UP - call sweep_quiz_room at the start of the two RPCs the
--    remaining players already invoke, so no cron job is needed.
--    Same signature as the version each function already has, so
--    CREATE OR REPLACE is enough, no DROP needed.
-- ============================================================

-- submit_quiz_answer - body otherwise unchanged from quiz_group_pvp.sql.
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
begin
  perform public.sweep_quiz_room(p_room_id);

  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;

  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

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


-- get_quiz_results - body otherwise unchanged from quiz_pvp_r2.sql
-- (icon/avatar_url/avatar_type included).
create or replace function public.get_quiz_results(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(game_type text, level text, players jsonb, answer_key jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  perform public.sweep_quiz_room(p_room_id);

  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;
  if v_room.status <> 'finished' then
    raise exception 'room not finished yet';
  end if;

  return query
  select
    v_room.game_type, v_room.level,
    (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'player_id', pr.player_id,
          'player_name', pr.player_name,
          'is_host', pr.is_host,
          'icon', pr.icon,
          'avatar_url', pr.avatar_url,
          'avatar_type', pr.avatar_type,
          'picks', (select coalesce(jsonb_object_agg(qa.question_index, qa.pick), '{}'::jsonb)
                      from public.quiz_room_answers qa
                      where qa.room_id = p_room_id and qa.player_id = pr.player_id),
          'points', (select coalesce(jsonb_object_agg(qa.question_index, qa.points), '{}'::jsonb)
                      from public.quiz_room_answers qa
                      where qa.room_id = p_room_id and qa.player_id = pr.player_id),
          'total_score', pr.total_score
        )
        order by pr.total_score desc, pr.joined_at asc
      ), '[]'::jsonb)
      from (
        select qp.player_id, qp.player_name, qp.is_host, qp.joined_at,
               u.icon, u.avatar_url, u.avatar_type,
               (select coalesce(sum(qa.points), 0)
                  from public.quiz_room_answers qa
                  where qa.room_id = p_room_id and qa.player_id = qp.player_id) as total_score
        from public.quiz_room_players qp
        left join public.users u on u.id::text = qp.player_id
        where qp.room_id = p_room_id
      ) pr
    ),
    (select quiz_room_keys.answer_key from public.quiz_room_keys where room_id = p_room_id);
end;
$$;

grant execute on function public.get_quiz_results(uuid, text, text) to anon, authenticated;


-- ============================================================
-- OPTIONAL - run separately, read-only, sanity checks
-- ============================================================
-- confirm the new function exists and who can call it:
-- select routine_name, security_type from information_schema.routines
-- where routine_schema = 'public' and routine_name = 'sweep_quiz_room';
--
-- select grantee, privilege_type from information_schema.role_routine_grants
-- where routine_name = 'sweep_quiz_room';
--
-- after a room has sat 'active' with a missing player past the
-- deadline, confirm the sweep landed forfeit rows (pick = -1 or ''):
-- select * from quiz_room_answers where room_id = '<room id>' order by question_index;
