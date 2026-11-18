-- ============================================================
--  quiz_category_isolation.sql — make the quiz question pools
--  category-aware (UFC vs Football), DATABASE ISOLATION LAYER ONLY
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom. Run AFTER
--  quiz_no_repeat.sql, quiz_group_pvp.sql, quiz_pvp_r2.sql,
--  quiz_pvp_host_leave.sql, quiz_presence.sql, quiz_results_fix.sql,
--  quiz_host_handover.sql and quiz_leave_v2.sql (i.e. against the
--  project as it stands today — every function this file touches was
--  re-confirmed byte-for-byte against the LIVE project via
--  pg_get_functiondef() on 2026-11-16, immediately before writing this).
--
--  Run BLOCK 1 first (entirely read-only) and review the output. Only
--  after that looks right, run BLOCK 2.
--
--  SCOPE — per FOOTBALL-QUIZ-PRD.md §3, Option A (locked decision):
--  keep the shared quiz_questions table, filter by the existing
--  `category` column, add a REQUIRED p_category parameter to the RPCs
--  that pool questions. This file does NOT seed any Football rows, does
--  NOT add any page/route/UI, and does NOT change any UFC-facing text.
--  After this file is applied, UFC must behave exactly as before, with
--  ufc/quiz.js passing category:'UFC' on every call site that now
--  requires it.
--
--  ── WHY guess_who_questions IS NOT TOUCHED ──
--  Confirmed live via information_schema (2026-11-16):
--  public.guess_who_questions has NO category column at all (columns are
--  id, level, clue1-4, answer, is_active, created_at — nothing else).
--  Football has no guess-who content (FOOTBALL-QUIZ-DATABASE.md is
--  multiple-choice only), so there is nothing to isolate on that side —
--  the whole table is implicitly UFC-only forever. Every function below
--  that branches on game_type='guess' queries guess_who_questions with
--  NO category filter, exactly as today. p_category is still a required
--  parameter on those same functions (so one call signature covers both
--  game types, and so the no-repeat history key in
--  quiz_user_seen_questions stays uniform across game types), it is just
--  not used to filter guess_who_questions specifically.
--
--  ── WHAT CHANGES ──
--   1. get_ai_quiz_questions(p_game_type, p_level) -> adds a required
--      p_category text param (quiz_no_repeat.sql). Every quiz_questions
--      query gains `and category = p_category`. The 'შერეული' (mixed)
--      sentinel still only drops the LEVEL filter, never the category
--      filter (v_mixed is unchanged; category is a separate AND clause).
--   2. quiz_user_seen_questions gains `category text not null`, added to
--      its primary key: (user_id, game_type, level, category,
--      question_id). Existing rows backfilled to 'UFC'. UFC and Football
--      no-repeat histories become fully independent per user.
--   3. create_quiz_room(p_game_type, p_level, ...) -> adds a required
--      p_category text param, placed BEFORE the two optional guest
--      params (p_guest_id/p_guest_name keep their defaults; Postgres
--      requires defaulted params to trail, so the new required param
--      goes in front of them). quiz_rooms gains `category text not null
--      default 'UFC'` (existing rows backfilled to 'UFC' by the column
--      default), plus a check (category in ('UFC','Football')).
--   4. join_quiz_room / rejoin_quiz_room / get_quiz_results all gain one
--      extra `category` column on their return table, read from
--      quiz_rooms.category, so a room a client is looking at (by code,
--      by reconnect, or at results time) carries its sport. No new
--      input parameter needed on any of the three — a room already
--      knows its own category once created.
--
--  ── WHY EXPLICIT DROP + CREATE OR REPLACE, NOT PLAIN "OR REPLACE" ──
--  Postgres refuses CREATE OR REPLACE FUNCTION when either the parameter
--  list or the return type/table-column-list changes — only the body may
--  change under OR REPLACE with an IDENTICAL signature. Every function
--  below changes one or both, so each is `drop function if exists
--  public.X(<the signature this file found LIVE>)` followed by `create or
--  replace function public.X(<new signature>) ...`. Using "or replace"
--  (not a bare "create") on the new signature, even right after a drop,
--  is what makes this file a true no-op on re-run: a second run's "drop
--  ... if exists <old signature>" no-ops (that signature is long gone),
--  and "create or replace <new signature>" simply replaces itself with
--  an identical body instead of erroring "function already exists".
--
--  Every other statement (the two ALTER TABLE sequences) is individually
--  idempotent (add column if not exists / update ... where ... is null /
--  set not null / drop constraint if exists + re-add) — running BLOCK 2
--  twice lands on the exact same end state both times, with no errors.
--
--  Not touched by this file (operate on an already-created room by
--  room_id only, never re-query quiz_questions/guess_who_questions, so
--  they need no category awareness): start_quiz_room, submit_quiz_answer,
--  reveal_quiz_clue, leave_quiz_room, sweep_quiz_room.
-- ============================================================


-- ============================================================
-- BLOCK 1 — DRY RUN / PREVIEW (read-only — no INSERT/UPDATE/DELETE/DDL
-- below this point until BLOCK 2). Safe to run anytime, as many times as
-- you like.
-- ============================================================

-- 1a. quiz_questions today, by category/level/is_active. Expect a single
-- category ('UFC') across every row.
select 'quiz_questions BEFORE' as what, category, level, is_active, count(*) as n
from public.quiz_questions
group by category, level, is_active
order by 1, 2, 3, 4;

-- 1b. Sanity: any row with a null/blank category today? Expect 0 — if
-- this returns > 0, STOP and investigate before running BLOCK 2, since
-- those rows would silently disappear from every category-filtered pool.
select 'quiz_questions rows with null/blank category (expect 0)' as what, count(*) as n
from public.quiz_questions
where category is null or length(trim(category)) = 0;

-- 1c. guess_who_questions today — confirm it genuinely has no category
-- column (this is WHY it is left untouched below, see header note).
-- Expect this to error with "column guess_who_questions.category does
-- not exist" — that error IS the confirmation.
-- select category from public.guess_who_questions limit 1;
select 'guess_who_questions columns today' as what, column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'guess_who_questions'
order by ordinal_position;

-- 1d. quiz_user_seen_questions — current primary key + row count that
-- BLOCK 2 would backfill to category='UFC'.
select 'quiz_user_seen_questions current pkey' as what, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid = 'public.quiz_user_seen_questions'::regclass and contype = 'p';

select 'quiz_user_seen_questions rows to backfill to UFC' as what, count(*) as n
from public.quiz_user_seen_questions;

-- 1e. quiz_rooms — current columns + row count that BLOCK 2 would
-- backfill to category='UFC' via the new column's default.
select 'quiz_rooms columns today' as what, column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'quiz_rooms'
order by ordinal_position;

select 'quiz_rooms rows to backfill to UFC' as what, count(*) as n
from public.quiz_rooms;

-- 1f. "Already applied?" guard preview — must be false before a first
-- run (neither column should exist yet).
select 'already applied? (must be false before first run)' as what,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quiz_user_seen_questions' and column_name = 'category'
    union all
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quiz_rooms' and column_name = 'category'
  ) as already_applied;

-- 1g. Current signatures of every function this file touches, for the
-- record (so you can diff against what BLOCK 2 installs).
select 'function signature today' as what, p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_ai_quiz_questions', 'create_quiz_room', 'join_quiz_room', 'rejoin_quiz_room', 'get_quiz_results')
order by p.proname;

-- 1h. UFC-resolves-correctly check, part 1: today's active UFC pool by
-- level (this is exactly what get_ai_quiz_questions(p_category:='UFC')
-- will draw from once BLOCK 2 is applied).
select 'active UFC quiz_questions pool by level (post-change p_category=UFC draws from this)' as what,
  level, count(*) as n
from public.quiz_questions
where category = 'UFC' and is_active = true
group by level
order by level;

-- 1i. UFC-resolves-correctly check, part 2: this count must equal 1h's
-- total, proving the category filter is a true no-op against today's
-- data (every active row is already 'UFC', so filtering by it changes
-- nothing about which rows UFC players see).
select
  (select count(*) from public.quiz_questions where is_active = true) as active_total_today,
  (select count(*) from public.quiz_questions where category = 'UFC' and is_active = true) as active_ufc_today,
  (select count(*) from public.quiz_questions where is_active = true)
    = (select count(*) from public.quiz_questions where category = 'UFC' and is_active = true) as pools_match_expect_true;

-- Note: get_ai_quiz_questions/create_quiz_room themselves can't be
-- invoked here with p_category to double-check live, because (a) before
-- BLOCK 2 runs they don't accept that parameter yet, and (b) the SQL
-- Editor has no auth.uid() session, so get_ai_quiz_questions would raise
-- "authentication required" regardless. 1h/1i above are the real
-- equivalent check (the exact WHERE clause the function will run). After
-- applying BLOCK 2, the actual functional check is: play the live UFC
-- quiz (vs-AI and PvP) once each and confirm it behaves exactly as
-- before.


-- ============================================================
-- BLOCK 2 — WRITES (run only after reviewing BLOCK 1's output)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 2a. quiz_user_seen_questions — add category, backfill, re-key
-- ------------------------------------------------------------
alter table public.quiz_user_seen_questions add column if not exists category text;

update public.quiz_user_seen_questions set category = 'UFC' where category is null;

alter table public.quiz_user_seen_questions alter column category set not null;

alter table public.quiz_user_seen_questions drop constraint if exists quiz_user_seen_questions_pkey;

alter table public.quiz_user_seen_questions
  add constraint quiz_user_seen_questions_pkey primary key (user_id, game_type, level, category, question_id);


-- ------------------------------------------------------------
-- 2b. RPC — get_ai_quiz_questions (quiz_no_repeat.sql) — adds required
-- p_category. guess_who_questions branch intentionally has no category
-- filter — see header note.
-- ------------------------------------------------------------
drop function if exists public.get_ai_quiz_questions(text, text);

create or replace function public.get_ai_quiz_questions(p_game_type text, p_level text, p_category text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_total int;
  v_seen  int;
  v_result jsonb;
  -- 'შერეული' (mixed) is a query-time sentinel only -- see the original
  -- comment in quiz_no_repeat.sql. Unchanged: it only ever drops the
  -- LEVEL filter. category is a separate AND clause below and is never
  -- dropped by v_mixed.
  v_mixed boolean := (p_level = 'შერეული');
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if p_game_type not in ('quiz', 'guess') then
    raise exception 'invalid game_type';
  end if;
  if p_category is null or length(trim(p_category)) = 0 then
    raise exception 'category required';
  end if;

  if p_game_type = 'quiz' then
    select count(*) into v_total from public.quiz_questions
      where (v_mixed or level = p_level) and category = p_category and is_active = true;
  else
    -- guess_who_questions has no category column (see header note) --
    -- deliberately no category filter on this branch.
    select count(*) into v_total from public.guess_who_questions
      where (v_mixed or level = p_level) and is_active = true;
  end if;

  if v_total = 0 then
    raise exception 'no questions available for % / % / %', p_game_type, p_level, p_category;
  end if;

  select count(*) into v_seen
    from public.quiz_user_seen_questions
    where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category;

  -- Full cycle done (or first time, or pool shrank below 10) -> reset
  -- history for this (game_type, level, category) triple only, then
  -- select from the fresh pool.
  if (v_total - v_seen) < 10 then
    delete from public.quiz_user_seen_questions
      where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category;
  end if;

  if p_game_type = 'quiz' then
    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
    from (
      select * from public.quiz_questions
      where (v_mixed or level = p_level) and category = p_category and is_active = true
        and id::text not in (
          select question_id from public.quiz_user_seen_questions
          where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category
        )
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    ) t;
  else
    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
    from (
      select * from public.guess_who_questions
      where (v_mixed or level = p_level) and is_active = true
        and id::text not in (
          select question_id from public.quiz_user_seen_questions
          where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category
        )
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    ) t;
  end if;

  insert into public.quiz_user_seen_questions (user_id, game_type, level, category, question_id, seen_at)
  select v_uid, p_game_type, p_level, p_category, (elem ->> 'id'), now()
  from jsonb_array_elements(v_result) elem
  on conflict (user_id, game_type, level, category, question_id) do nothing;

  return v_result;
end;
$$;

grant execute on function public.get_ai_quiz_questions(text, text, text) to anon, authenticated;


-- ------------------------------------------------------------
-- 2c. quiz_rooms — add category, backfill via default, constrain
-- ------------------------------------------------------------
alter table public.quiz_rooms add column if not exists category text;

update public.quiz_rooms set category = 'UFC' where category is null;

alter table public.quiz_rooms alter column category set default 'UFC';

alter table public.quiz_rooms alter column category set not null;

alter table public.quiz_rooms drop constraint if exists quiz_rooms_category_check;

alter table public.quiz_rooms add constraint quiz_rooms_category_check check (category in ('UFC', 'Football'));


-- ------------------------------------------------------------
-- 2d. RPC — create_quiz_room (live body per quiz_group_pvp.sql, untouched
-- since — confirmed via pg_get_functiondef() 2026-11-16). Adds required
-- p_category, placed before the two defaulted guest params. guess_who
-- branch intentionally has no category filter — see header note.
-- ------------------------------------------------------------
drop function if exists public.create_quiz_room(text, text, text, text);

create or replace function public.create_quiz_room(
  p_game_type text, p_level text, p_category text, p_guest_id text default null, p_guest_name text default null
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
  -- 'შერეული' (mixed) is a query-time sentinel, never a stored `level`
  -- value -- see the matching note in quiz_no_repeat.sql's
  -- get_ai_quiz_questions(). The room itself still records p_level
  -- ('შერეული') as-is in quiz_rooms.level further down, purely for display.
  v_mixed boolean := (p_level = 'შერეული');
begin
  if p_game_type not in ('quiz', 'guess') then
    raise exception 'invalid game_type';
  end if;
  if p_category is null or length(trim(p_category)) = 0 then
    raise exception 'category required';
  end if;

  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);

  if p_game_type = 'quiz' then
    for v_row in
      select question, options, correct_index
      from public.quiz_questions
      where (v_mixed or level = p_level) and category = p_category and is_active = true
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    loop
      v_questions := v_questions || jsonb_build_array(jsonb_build_object('q', v_row.question, 'o', v_row.options));
      v_key := v_key || jsonb_build_array(v_row.correct_index);
    end loop;
  else
    -- guess_who_questions has no category column (see header note) --
    -- deliberately no category filter on this branch.
    for v_row in
      select clue1, clue2, clue3, clue4, answer
      from public.guess_who_questions
      where (v_mixed or level = p_level) and is_active = true
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
    raise exception 'no questions available for % / % / %', p_game_type, p_level, p_category;
  end if;

  loop
    v_code := public.quiz_gen_code();
    v_tries := v_tries + 1;
    begin
      insert into public.quiz_rooms (code, game_type, level, category, status, host_id, host_name, questions)
        values (v_code, p_game_type, p_level, p_category, 'waiting', v_player.player_id, v_player.player_name, v_questions)
        returning id into v_room_id;
      exit;
    exception when unique_violation then
      if v_tries > 8 then raise exception 'could not allocate a room code, try again'; end if;
    end;
  end loop;

  insert into public.quiz_room_keys (room_id, answer_key) values (v_room_id, v_key);

  -- Host is a player too -- room stays 'waiting' until start_quiz_room is
  -- explicitly called.
  insert into public.quiz_room_players (room_id, player_id, player_name, is_host)
    values (v_room_id, v_player.player_id, v_player.player_name, true);

  return query select v_room_id, v_code, v_questions;
end;
$$;

grant execute on function public.create_quiz_room(text, text, text, text, text) to anon, authenticated;


-- ------------------------------------------------------------
-- 2e. RPC — join_quiz_room (live body per quiz_group_pvp.sql, untouched
-- since — confirmed via pg_get_functiondef() 2026-11-16). Adds `category`
-- to the return table only — no new input parameter, the room already
-- knows its own category.
-- ------------------------------------------------------------
drop function if exists public.join_quiz_room(text, text, text);

create or replace function public.join_quiz_room(
  p_code text, p_guest_id text default null, p_guest_name text default null
) returns table(room_id uuid, game_type text, level text, questions jsonb, host_name text, category text)
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
  if exists (select 1 from public.quiz_room_players where quiz_room_players.room_id = v_room.id and quiz_room_players.player_id = v_player.player_id) then
    return query select v_room.id, v_room.game_type, v_room.level, v_room.questions, v_room.host_name, v_room.category;
    return;
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'room already full or finished';
  end if;
  if v_room.host_id = v_player.player_id then
    raise exception 'cannot join your own room';
  end if;

  select count(*) into v_count from public.quiz_room_players where quiz_room_players.room_id = v_room.id;
  if v_count >= v_room.max_players then
    raise exception 'room is full';
  end if;

  insert into public.quiz_room_players (room_id, player_id, player_name, is_host)
    values (v_room.id, v_player.player_id, v_player.player_name, false);

  return query select v_room.id, v_room.game_type, v_room.level, v_room.questions, v_room.host_name, v_room.category;
end;
$$;

grant execute on function public.join_quiz_room(text, text, text) to anon, authenticated;


-- ------------------------------------------------------------
-- 2f. RPC — rejoin_quiz_room (live body per quiz_leave_v2.sql, confirmed
-- via pg_get_functiondef() 2026-11-16 — this is the version with the
-- `forfeited` check, NOT the older quiz_group_pvp.sql body). Adds
-- `category` to the return table only.
-- ------------------------------------------------------------
drop function if exists public.rejoin_quiz_room(uuid, text, text);

create or replace function public.rejoin_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(
  status text, code text, game_type text, level text, max_players int,
  questions jsonb, players jsonb, answered_indexes int[], category text
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
                      v_room.questions, v_players, v_answered, v_room.category;
end;
$$;

grant execute on function public.rejoin_quiz_room(uuid, text, text) to anon, authenticated;


-- ------------------------------------------------------------
-- 2g. RPC — get_quiz_results (live body per quiz_results_fix.sql,
-- confirmed via pg_get_functiondef() 2026-11-16 — this is the version
-- with the sweep_quiz_room() call and the avatar left-join, NOT the
-- older quiz_group_pvp.sql/quiz_pvp_r2.sql bodies). Adds `category` to
-- the return table only.
-- ------------------------------------------------------------
drop function if exists public.get_quiz_results(uuid, text, text);

create or replace function public.get_quiz_results(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(game_type text, level text, players jsonb, answer_key jsonb, category text)
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
    (select quiz_room_keys.answer_key from public.quiz_room_keys where room_id = p_room_id),
    v_room.category;
end;
$$;

grant execute on function public.get_quiz_results(uuid, text, text) to anon, authenticated;

commit;


-- ============================================================
-- OPTIONAL — run separately, read-only, after BLOCK 2, to confirm the
-- new state
-- ============================================================
-- select proname, pg_get_function_identity_arguments(oid) as args
-- from pg_proc where pronamespace = 'public'::regnamespace
--   and proname in ('get_ai_quiz_questions','create_quiz_room','join_quiz_room','rejoin_quiz_room','get_quiz_results')
-- order by proname;
--
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid in ('public.quiz_user_seen_questions'::regclass, 'public.quiz_rooms'::regclass);
--
-- select category, count(*) from public.quiz_user_seen_questions group by category;
-- select category, count(*) from public.quiz_rooms group by category;
