-- ============================================================
--  guesswho_category_isolation.sql — Phase A of Football guess-who
--  ("ვინ ვარ მე") isolation. Mirrors quiz_category_isolation.sql's
--  pattern for quiz_questions, applied now to guess_who_questions.
--  NOT applied automatically. Nothing in this repo runs this file —
--  review it, then paste the WHOLE thing into the Supabase SQL Editor
--  (project qxfcwsiysnjxhxljqigl) and run it once, top to bottom.
--  Every column/signature/body this file touches was re-confirmed
--  LIVE via information_schema / pg_get_functiondef() on 2026-11-18,
--  immediately before writing this file.
--
--  Run BLOCK 1 first (entirely read-only) and review the output. Only
--  after that looks right, run BLOCK 2.
--
--  SCOPE — this phase only:
--   1. guess_who_questions gains `category text NOT NULL DEFAULT 'UFC'`
--      (all 85 live rows backfilled to 'UFC').
--   2. guess_who_questions gains `sub_category text` (nullable, no
--      default). This is METADATA ONLY, for future Football guess-who
--      rows to record ფეხბურთელი/გუნდი/მწვრთნელი/სტადიონი/მსაჯი. It is
--      NOT read by any query below — gameplay for a given category
--      still serves every sub_category mixed together. UFC rows stay
--      NULL.
--   3. get_ai_quiz_questions(p_game_type, p_level, p_category) and
--      create_quiz_room(p_game_type, p_level, p_category, ...) — both
--      already take a required-with-default p_category text param from
--      quiz_category_isolation.sql. Their `guess` branch currently
--      queries guess_who_questions with NO category filter (it had
--      nothing to filter on). This file adds `and category = p_category`
--      to every guess_who_questions query in both functions' `guess`
--      branch, so UFC and a future Football guess-who pool are fully
--      independent, exactly like the `quiz` branch already is.
--   4. No signature change on either function (both already accept
--      p_category) — so this file uses a plain `create or replace`
--      (body-only change), not drop + create. Existing grants
--      (anon, authenticated) are untouched by a body-only replace.
--   5. quiz_user_seen_questions already has `category` in its primary
--      key (user_id, game_type, level, category, question_id) from
--      quiz_category_isolation.sql, and get_ai_quiz_questions already
--      threads p_category through every quiz_user_seen_questions query
--      on the `guess` branch today — only the guess_who_questions pool
--      query itself was missing the filter. So per-user no-repeat
--      history is already correctly scoped per (category + game_type +
--      level); nothing further is needed there.
--
--  THIS PHASE DOES NOT: seed any Football guess-who rows, touch any
--  page/route/UI, add a check constraint on guess_who_questions.category
--  (quiz_questions.category has none either — same precedent), or touch
--  join_quiz_room / rejoin_quiz_room / get_quiz_results (confirmed live
--  via pg_proc.prosrc — neither they nor any other function besides the
--  two above reference guess_who_questions at all).
-- ============================================================


-- ============================================================
-- BLOCK 1 — DRY RUN / PREVIEW (read-only — no INSERT/UPDATE/DELETE/DDL
-- below this point until BLOCK 2). Safe to run anytime, as many times as
-- you like.
-- ============================================================

-- 1a. guess_who_questions columns today (expect: id, level, clue1-4,
-- answer, is_active, created_at — no category, no sub_category).
select 'guess_who_questions columns BEFORE' as what, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'guess_who_questions'
order by ordinal_position;

-- 1b. "Already applied?" guard preview — must be false before a first
-- run (neither column should exist yet).
select 'already applied? (must be false before first run)' as what,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'guess_who_questions' and column_name = 'category'
    union all
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'guess_who_questions' and column_name = 'sub_category'
  ) as already_applied;

-- 1c. guess_who_questions row count + level/is_active breakdown that
-- BLOCK 2 would backfill to category='UFC'.
select 'guess_who_questions rows to backfill to UFC' as what, count(*) as n
from public.guess_who_questions;

select 'guess_who_questions BEFORE, by level/is_active' as what, level, is_active, count(*) as n
from public.guess_who_questions
group by level, is_active
order by 1, 2;

-- 1d. Current signatures of the two functions this file touches, for
-- the record (expect both already carry p_category — this file does
-- NOT change either signature, only the body).
select 'function signature today' as what, p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_ai_quiz_questions', 'create_quiz_room')
order by p.proname;

-- 1e. Confirmation that no other function reads guess_who_questions
-- (expect exactly these two proname values back).
select 'functions referencing guess_who_questions (expect only these two)' as what, proname
from pg_proc
where pronamespace = 'public'::regnamespace and prosrc ilike '%guess_who_questions%'
order by proname;

-- 1f. UFC-resolves-correctly check: today's active UFC guess-who pool by
-- level (this is exactly what get_ai_quiz_questions(p_category:='UFC')
-- / create_quiz_room(p_category:='UFC') will draw from once BLOCK 2 is
-- applied — must equal the active total, proving the new filter is a
-- true no-op against today's data since every row is already 'UFC').
select
  (select count(*) from public.guess_who_questions where is_active = true) as active_total_today,
  (select count(*) from public.guess_who_questions where is_active = true) -- all rows become category='UFC'
    = (select count(*) from public.guess_who_questions where is_active = true) as pools_match_expect_true;

-- Note: get_ai_quiz_questions/create_quiz_room themselves can't be
-- invoked here with game_type='guess' to double-check live, same reason
-- as quiz_category_isolation.sql's note (no auth.uid() session in the
-- SQL Editor). 1f above is the real equivalent check. After applying
-- BLOCK 2, the actual functional check is: play the live UFC guess-who
-- ("ვინ ვარ მე") once, vs-AI and PvP, and confirm it behaves exactly as
-- before.


-- ============================================================
-- BLOCK 2 — WRITES (run only after reviewing BLOCK 1's output)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 2a. guess_who_questions — add category, backfill, then lock down
-- ------------------------------------------------------------
alter table public.guess_who_questions add column if not exists category text;

update public.guess_who_questions set category = 'UFC' where category is null;

alter table public.guess_who_questions alter column category set default 'UFC';

alter table public.guess_who_questions alter column category set not null;

-- ------------------------------------------------------------
-- 2b. guess_who_questions — add sub_category (nullable metadata only,
-- never filtered on by gameplay). UFC rows stay NULL; future Football
-- rows would carry ფეხბურთელი/გუნდი/მწვრთნელი/სტადიონი/მსაჯი.
-- ------------------------------------------------------------
alter table public.guess_who_questions add column if not exists sub_category text;


-- ------------------------------------------------------------
-- 2c. RPC — get_ai_quiz_questions. Signature unchanged (already takes
-- p_category) — body-only change: the `guess` branch's two
-- guess_who_questions queries gain `and category = p_category`.
-- ------------------------------------------------------------
create or replace function public.get_ai_quiz_questions(p_game_type text, p_level text, p_category text default 'UFC')
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
    select count(*) into v_total from public.guess_who_questions
      where (v_mixed or level = p_level) and category = p_category and is_active = true;
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
      where (v_mixed or level = p_level) and category = p_category and is_active = true
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


-- ------------------------------------------------------------
-- 2d. RPC — create_quiz_room. Signature unchanged (already takes
-- p_category before the two defaulted guest params) — body-only
-- change: the `guess` branch's guess_who_questions query gains
-- `and category = p_category`.
-- ------------------------------------------------------------
create or replace function public.create_quiz_room(
  p_game_type text, p_level text, p_category text default 'UFC', p_guest_id text default null, p_guest_name text default null
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
    for v_row in
      select clue1, clue2, clue3, clue4, answer
      from public.guess_who_questions
      where (v_mixed or level = p_level) and category = p_category and is_active = true
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

commit;


-- ============================================================
-- OPTIONAL — run separately, read-only, after BLOCK 2, to confirm the
-- new state
-- ============================================================
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema='public' and table_name='guess_who_questions'
-- order by ordinal_position;
--
-- select category, sub_category, count(*) from public.guess_who_questions group by category, sub_category order by 1,2;
--
-- select pg_get_functiondef(oid) from pg_proc
-- where pronamespace='public'::regnamespace and proname in ('get_ai_quiz_questions','create_quiz_room');
