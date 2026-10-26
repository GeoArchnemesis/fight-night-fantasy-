-- ============================================================
--  quiz_group_pvp.sql — UFC Quiz Phase Q2 (group PvP, host + up to 8 friends)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom, AFTER
--  quiz_no_repeat.sql (no dependency between them, but that's the agreed
--  order). Safe to re-run top-to-bottom, including after a partial
--  failure.
--
--  Scope: replaces the 1v1-only PvP model from quiz_pvp.sql with an
--  N-player (host + up to 8 friends, 9 total) model. PvP has never been
--  deployed/wired to the frontend, so there are no live rooms to migrate —
--  this is a clean schema replacement, not a dual-path compatibility
--  layer. quiz_room_answers and quiz_room_keys are untouched (already
--  keyed by player_id, so they already work for N players).
--
--  ── WHY SOME FUNCTIONS ARE DROPPED, NOT JUST "CREATE OR REPLACE"-D ──
--  Postgres refuses `CREATE OR REPLACE FUNCTION` when the return type
--  changes (only the body may change under OR REPLACE). get_quiz_results
--  and rejoin_quiz_room both need a different return shape for N players
--  (a single `players jsonb` array instead of fixed host_name/guest_name/
--  host_picks/guest_picks columns), and create_quiz_room now also returns
--  the room's `questions` (the host needs them client-side the moment the
--  room starts, the same way a joining guest already gets them from
--  join_quiz_room — avoids a second round-trip at start time). So those
--  three are `DROP FUNCTION IF EXISTS` + `CREATE FUNCTION`. Every other
--  statement in this file is IF NOT EXISTS / OR REPLACE.
--
--  ── SCHEMA CHANGES ──
--   1. quiz_rooms.max_players int, default 9 (host + 8 friends).
--   2. quiz_rooms.guest_id / guest_name / guest_finished_at /
--      host_finished_at are DROPPED. Per-player "who's in, who's done" now
--      lives entirely in the new quiz_room_players table below — these
--      columns would otherwise sit there unused and confusing, and no
--      code anywhere (this repo, the bot, admin) reads them outside
--      quiz_pvp.sql itself (confirmed by grep before writing this).
--   3. New table quiz_room_players (room_id, player_id, player_name,
--      is_host, joined_at, finished_at) — RLS on, permissive SELECT (no
--      secrets in it, same reasoning as quiz_rooms itself — needed for
--      Realtime so the lobby can show who joined live), zero write
--      policies (all writes go through the SECURITY DEFINER RPCs below).
--      Added to the supabase_realtime publication alongside quiz_rooms.
--
--  ── RPC CHANGES (per PRD §2.2-2.3) ──
--   - create_quiz_room: generates the question set exactly as before,
--     but now also inserts the host into quiz_room_players (is_host=true)
--     and returns the questions alongside room_id/code. Room stays
--     'waiting' — it does NOT go active just because someone created it;
--     the host must call start_quiz_room.
--   - join_quiz_room: allows joining while status='waiting' AND current
--     player count < max_players. Does NOT flip the room to 'active'
--     (unlike the old 1v1 version, which activated on the single guest
--     joining) — only start_quiz_room does that. Calling it again with a
--     code you already joined is a harmless no-op (returns the same room
--     info instead of erroring), so a double-tap on "join" can't fail.
--   - start_quiz_room(p_room_id) — NEW. Host-only, requires >= 2 players
--     (host + at least 1 friend — a 1-player "room" is pointless, that's
--     what vs-AI is for), sets status='active', started_at=now().
--   - submit_quiz_answer: scoring logic is 100% unchanged from
--     quiz_pvp.sql. Only the "is this room done" check changes: it now
--     sets THIS player's quiz_room_players.finished_at once they've
--     answered all questions, then flips quiz_rooms.status to 'finished'
--     only once EVERY row in quiz_room_players for the room has
--     finished_at set (bool_and), instead of the old hardcoded
--     host_finished_at AND guest_finished_at check.
--   - get_quiz_results: returns (game_type, level, players, answer_key)
--     where `players` is a jsonb array of
--     {player_id, player_name, is_host, picks, points, total_score},
--     sorted by total_score descending (ready for the podium UI).
--   - reveal_quiz_clue / leave_quiz_room / rejoin_quiz_room: participant
--     checks updated from "is this the host or the one guest" to "is this
--     player a row in quiz_room_players for this room". leave_quiz_room's
--     room-abandon logic is extended for N players: the room is abandoned
--     if the host leaves during 'waiting', or if removing this player
--     leaves zero players; leaving mid-game ('active') re-checks whether
--     all REMAINING players are now finished (so the room doesn't get
--     stuck 'active' forever if the last unfinished player quits).
--     rejoin_quiz_room now returns the full `players` list (jsonb) instead
--     of host_name/guest_name, so a page refresh can rebuild the lobby or
--     in-progress view for any player, not just a 1v1 pair.
--
--  Keep in sync with ufc/quiz.js if you ever change this: questions per
--  game (currently 10, `limit 10` — only in create_quiz_room, which is
--  otherwise unchanged from quiz_pvp.sql) and max room size (9, i.e. host
--  + 8 friends).
-- ============================================================


-- ============================================================
-- 1) SCHEMA — quiz_rooms.max_players, drop the old 1v1 columns,
--    quiz_room_players table + RLS + Realtime
-- ============================================================
alter table public.quiz_rooms add column if not exists max_players int not null default 9;

alter table public.quiz_rooms drop column if exists guest_id;
alter table public.quiz_rooms drop column if exists guest_name;
alter table public.quiz_rooms drop column if exists guest_finished_at;
alter table public.quiz_rooms drop column if exists host_finished_at;

create table if not exists public.quiz_room_players (
  room_id     uuid not null references public.quiz_rooms(id) on delete cascade,
  player_id   text not null,
  player_name text not null,
  is_host     boolean not null default false,
  joined_at   timestamptz not null default now(),
  finished_at timestamptz,
  primary key (room_id, player_id)
);

alter table public.quiz_room_players replica identity full;
alter table public.quiz_room_players enable row level security;

-- Same reasoning as quiz_rooms in quiz_pvp.sql: nothing secret here (just
-- names/host flag/finished timestamp), so a permissive SELECT is what lets
-- Realtime deliver "who joined" to every player in the lobby.
drop policy if exists quiz_room_players_select_all on public.quiz_room_players;
create policy quiz_room_players_select_all on public.quiz_room_players for select using (true);

grant select on public.quiz_room_players to anon, authenticated;
grant all on public.quiz_room_players to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'quiz_room_players'
  ) then
    alter publication supabase_realtime add table public.quiz_room_players;
  end if;
end $$;


-- ============================================================
-- 2) RPC — create_quiz_room (return type changes: adds `questions`)
-- ============================================================
drop function if exists public.create_quiz_room(text, text, text, text);

create function public.create_quiz_room(
  p_game_type text, p_level text, p_guest_id text default null, p_guest_name text default null
) returns table(room_id uuid, code text, questions jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_code text;
  v_room_id uuid;
  v_questions jsonb := '[]'::jsonb;
  v_key jsonb := '[]'::jsonb;
  v_row record;
  v_clues jsonb;
  v_tries int := 0;
begin
  if p_game_type not in ('quiz', 'guess') then
    raise exception 'invalid game_type';
  end if;

  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);

  if p_game_type = 'quiz' then
    for v_row in
      select question, options, correct_index
      from public.quiz_questions
      where level = p_level and is_active = true
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    loop
      v_questions := v_questions || jsonb_build_array(jsonb_build_object('q', v_row.question, 'o', v_row.options));
      v_key := v_key || jsonb_build_array(v_row.correct_index);
    end loop;
  else
    for v_row in
      select clue1, clue2, clue3, clue4, answer
      from public.guess_who_questions
      where level = p_level and is_active = true
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    loop
      v_clues := '[]'::jsonb;
      if v_row.clue1 is not null and length(trim(v_row.clue1)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue1); end if;
      if v_row.clue2 is not null and length(trim(v_row.clue2)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue2); end if;
      if v_row.clue3 is not null and length(trim(v_row.clue3)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue3); end if;
      if v_row.clue4 is not null and length(trim(v_row.clue4)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue4); end if;
      v_questions := v_questions || jsonb_build_array(jsonb_build_object('clues', v_clues));
      v_key := v_key || jsonb_build_array(v_row.answer);
    end loop;
  end if;

  if jsonb_array_length(v_questions) = 0 then
    raise exception 'no questions available for % / %', p_game_type, p_level;
  end if;

  loop
    v_code := public.quiz_gen_code();
    v_tries := v_tries + 1;
    begin
      insert into public.quiz_rooms (code, game_type, level, status, host_id, host_name, questions)
        values (v_code, p_game_type, p_level, 'waiting', v_player.player_id, v_player.player_name, v_questions)
        returning id into v_room_id;
      exit;
    exception when unique_violation then
      if v_tries > 8 then raise exception 'could not allocate a room code, try again'; end if;
    end;
  end loop;

  insert into public.quiz_room_keys (room_id, answer_key) values (v_room_id, v_key);

  -- Host is a player too (per PRD §2.2) — room stays 'waiting' until
  -- start_quiz_room is explicitly called, unlike the old 1v1 auto-activate.
  insert into public.quiz_room_players (room_id, player_id, player_name, is_host)
    values (v_room_id, v_player.player_id, v_player.player_name, true);

  return query select v_room_id, v_code, v_questions;
end;
$$;

grant execute on function public.create_quiz_room(text, text, text, text) to anon, authenticated;


-- ============================================================
-- 3) RPC — join_quiz_room (capacity check replaces 1-guest-only)
-- ============================================================
create or replace function public.join_quiz_room(
  p_code text, p_guest_id text default null, p_guest_name text default null
) returns table(room_id uuid, game_type text, level text, questions jsonb, host_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_count int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);

  select * into v_room from public.quiz_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'room not found';
  end if;
  if v_room.created_at < now() - interval '30 minutes' and v_room.status = 'waiting' then
    update public.quiz_rooms set status = 'abandoned' where id = v_room.id;
    raise exception 'room expired';
  end if;

  -- Already in this room (refresh / double-tap on "join") — idempotent,
  -- just return the room as-is instead of erroring.
  if exists (select 1 from public.quiz_room_players where room_id = v_room.id and player_id = v_player.player_id) then
    return query select v_room.id, v_room.game_type, v_room.level, v_room.questions, v_room.host_name;
    return;
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'room already full or finished';
  end if;
  if v_room.host_id = v_player.player_id then
    raise exception 'cannot join your own room';
  end if;

  select count(*) into v_count from public.quiz_room_players where room_id = v_room.id;
  if v_count >= v_room.max_players then
    raise exception 'room is full';
  end if;

  insert into public.quiz_room_players (room_id, player_id, player_name, is_host)
    values (v_room.id, v_player.player_id, v_player.player_name, false);

  return query select v_room.id, v_room.game_type, v_room.level, v_room.questions, v_room.host_name;
end;
$$;

grant execute on function public.join_quiz_room(text, text, text) to anon, authenticated;


-- ============================================================
-- 4) RPC — start_quiz_room (NEW) — host-only, >= 2 players
-- ============================================================
create or replace function public.start_quiz_room(p_room_id uuid, p_guest_id text default null, p_guest_name text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_count int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'waiting' then raise exception 'room already started or finished'; end if;
  if v_room.host_id <> v_player.player_id then raise exception 'only the host can start the room'; end if;

  select count(*) into v_count from public.quiz_room_players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'need at least 2 players to start';
  end if;

  update public.quiz_rooms set status = 'active', started_at = now() where id = p_room_id;
end;
$$;

grant execute on function public.start_quiz_room(uuid, text, text) to anon, authenticated;


-- ============================================================
-- 5) RPC — reveal_quiz_clue (participant check updated for N players)
-- ============================================================
create or replace function public.reveal_quiz_clue(
  p_room_id uuid, p_question_index int, p_guest_id text default null, p_guest_name text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_max int;
  v_new int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;
  if v_room.game_type <> 'guess' then raise exception 'not a guess-who room'; end if;
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;
  if p_question_index < 0 or p_question_index >= jsonb_array_length(v_room.questions) then
    raise exception 'bad question index';
  end if;

  v_max := jsonb_array_length(v_room.questions -> p_question_index -> 'clues');

  insert into public.quiz_room_answers (room_id, player_id, question_index, clues_shown)
    values (p_room_id, v_player.player_id, p_question_index, least(2, v_max))
  on conflict (room_id, player_id, question_index)
    do update set clues_shown = least(public.quiz_room_answers.clues_shown + 1, v_max)
  returning clues_shown into v_new;

  return v_new;
end;
$$;

grant execute on function public.reveal_quiz_clue(uuid, int, text, text) to anon, authenticated;


-- ============================================================
-- 6) RPC — submit_quiz_answer (finish check now covers N players)
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
begin
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


-- ============================================================
-- 7) RPC — get_quiz_results (return type changes: one players[] array)
-- ============================================================
drop function if exists public.get_quiz_results(uuid, text, text);

create function public.get_quiz_results(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(game_type text, level text, players jsonb, answer_key jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
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
               (select coalesce(sum(qa.points), 0)
                  from public.quiz_room_answers qa
                  where qa.room_id = p_room_id and qa.player_id = qp.player_id) as total_score
        from public.quiz_room_players qp
        where qp.room_id = p_room_id
      ) pr
    ),
    (select quiz_room_keys.answer_key from public.quiz_room_keys where room_id = p_room_id);
end;
$$;

grant execute on function public.get_quiz_results(uuid, text, text) to anon, authenticated;


-- ============================================================
-- 8) RPC — rejoin_quiz_room (return type changes: players[] instead of
--    host_name/guest_name)
-- ============================================================
drop function if exists public.rejoin_quiz_room(uuid, text, text);

create function public.rejoin_quiz_room(
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
-- 9) RPC — leave_quiz_room (N-player abandon/finish logic)
-- ============================================================
create or replace function public.leave_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_remaining int;
  v_all_finished boolean;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then return; end if;  -- already gone, nothing to do
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

  delete from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id;

  select count(*) into v_remaining from public.quiz_room_players where room_id = p_room_id;

  if v_room.status = 'waiting' then
    if v_player.player_id = v_room.host_id or v_remaining = 0 then
      update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
    end if;
  elsif v_room.status = 'active' then
    if v_remaining = 0 then
      update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
    else
      -- The player who just left might have been the last unfinished one —
      -- recheck, otherwise the room could get stuck 'active' forever with
      -- nothing left to trigger the finish check in submit_quiz_answer.
      select bool_and(finished_at is not null) into v_all_finished
        from public.quiz_room_players where room_id = p_room_id;
      if v_all_finished then
        update public.quiz_rooms set status = 'finished' where id = p_room_id and status <> 'finished';
      end if;
    end if;
  end if;
end;
$$;

grant execute on function public.leave_quiz_room(uuid, text, text) to anon, authenticated;


-- ============================================================
-- OPTIONAL — run separately, read-only, sanity checks
-- ============================================================
-- confirm the dropped columns are actually gone:
-- select column_name from information_schema.columns
-- where table_schema='public' and table_name='quiz_rooms' order by column_name;
--
-- confirm quiz_room_players grants (anon/authenticated should show SELECT only):
-- select table_name, grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'quiz_room_players'
-- order by grantee, privilege_type;
--
-- confirm it's in the realtime publication:
-- select tablename from pg_publication_tables
-- where pubname = 'supabase_realtime' and schemaname = 'public';
