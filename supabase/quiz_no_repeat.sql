-- ============================================================
--  quiz_no_repeat.sql — UFC Quiz Phase Q1 (no-repeat questions, vs-AI only)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom. Safe to re-run,
--  including re-running after a partial failure — every statement is
--  IF NOT EXISTS / OR REPLACE, nothing here is dropped-then-recreated in a
--  way that would lose data.
--
--  Scope: vs-AI quiz + guess-who only (PRD §1.1). PvP rooms are untouched —
--  they keep generating a fully random question set per room, since every
--  player in a room needs the SAME shared set at the same time.
--
--  ── id column (confirmed via information_schema, 2026-10-26) ──
--  `quiz_questions.id` and `guess_who_questions.id` already exist as
--  populated, stable `bigint` primary keys. This script does NOT alter
--  either table in any way — it only ever reads from them. Every place
--  that compares or stores one of these ids casts it to text explicitly
--  (`id::text`, or `elem ->> 'id'` which jsonb already returns as text) to
--  match `quiz_user_seen_questions.question_id`, which is `text` and
--  carries no foreign key on purpose — this lets the same seen-tracking
--  table serve both quiz_questions (bigint id) and guess_who_questions
--  (also bigint id, but kept untyped/uncoupled here deliberately, so nothing
--  breaks if that ever changes) without needing two separate tables.
--
--  What this does, in order:
--   1. Creates quiz_user_seen_questions — RLS on, ZERO grants to
--      anon/authenticated, same pattern as quiz_room_keys in quiz_pvp.sql
--      (access only through the SECURITY DEFINER RPC below, which runs as
--      `postgres` and bypasses RLS as the table owner).
--   2. Creates get_ai_quiz_questions(p_game_type, p_level) — the one RPC
--      ufc/quiz.js calls for vs-AI question selection (see PRD §1.2-1.4):
--        - requires auth.uid() (login already required to play at all,
--          per QuizUpdates.pdf / quiz_resolve_player in quiz_pvp.sql)
--        - if the user's remaining (unseen) pool at this (game_type,
--          level) is < 10, clears their seen-history for that pair first
--          (a full cycle just completed) THEN selects from the fresh,
--          full pool
--        - picks 10 random questions, marks them seen, returns full rows
--          (row_to_json over `select *`, same as the client's existing
--          `select('*')` — so ufc/quiz.js's normalizeRow/
--          normalizeGuessRow need no changes to the row SHAPE, only to
--          how they're fetched)
--
--  Keep in sync with ufc/quiz.js if you ever change this: questions per
--  game (currently 10, hardcoded as `limit 10` below, matching
--  QUESTIONS_PER_GAME and quiz_pvp.sql's own `limit 10`).
-- ============================================================


-- ============================================================
-- 1) TABLE — quiz_user_seen_questions
-- ============================================================
create table if not exists public.quiz_user_seen_questions (
  user_id     uuid not null,
  game_type   text not null check (game_type in ('quiz','guess')),
  level       text not null,
  question_id text not null,   -- quiz_questions.id / guess_who_questions.id, cast to text — see note above on why not a typed FK
  seen_at     timestamptz not null default now(),
  primary key (user_id, game_type, level, question_id)
);

alter table public.quiz_user_seen_questions enable row level security;

-- No policy, no grant for anon/authenticated at all — exactly the
-- quiz_room_keys pattern in quiz_pvp.sql. Only service_role (and the
-- SECURITY DEFINER RPC below, running as table owner postgres) can touch
-- this table.
grant all on public.quiz_user_seen_questions to service_role;


-- ============================================================
-- 2) RPC — get_ai_quiz_questions
-- ============================================================
create or replace function public.get_ai_quiz_questions(p_game_type text, p_level text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_total int;
  v_seen  int;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if p_game_type not in ('quiz', 'guess') then
    raise exception 'invalid game_type';
  end if;

  if p_game_type = 'quiz' then
    select count(*) into v_total from public.quiz_questions where level = p_level and is_active = true;
  else
    select count(*) into v_total from public.guess_who_questions where level = p_level and is_active = true;
  end if;

  if v_total = 0 then
    raise exception 'no questions available for % / %', p_game_type, p_level;
  end if;

  select count(*) into v_seen
    from public.quiz_user_seen_questions
    where user_id = v_uid and game_type = p_game_type and level = p_level;

  -- Full cycle done (or first time, or pool shrank below 10) -> reset history
  -- for this (game_type, level) pair only, then select from the fresh pool.
  if (v_total - v_seen) < 10 then
    delete from public.quiz_user_seen_questions
      where user_id = v_uid and game_type = p_game_type and level = p_level;
  end if;

  if p_game_type = 'quiz' then
    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
    from (
      select * from public.quiz_questions
      where level = p_level and is_active = true
        and id::text not in (
          select question_id from public.quiz_user_seen_questions
          where user_id = v_uid and game_type = p_game_type and level = p_level
        )
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    ) t;
  else
    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
    from (
      select * from public.guess_who_questions
      where level = p_level and is_active = true
        and id::text not in (
          select question_id from public.quiz_user_seen_questions
          where user_id = v_uid and game_type = p_game_type and level = p_level
        )
      order by random()
      limit 10                       -- keep in sync with quiz.js QUESTIONS_PER_GAME
    ) t;
  end if;

  -- elem ->> 'id' is already text (jsonb's ->> always returns text,
  -- regardless of the underlying bigint value) — matches question_id text.
  insert into public.quiz_user_seen_questions (user_id, game_type, level, question_id, seen_at)
  select v_uid, p_game_type, p_level, (elem ->> 'id'), now()
  from jsonb_array_elements(v_result) elem
  on conflict (user_id, game_type, level, question_id) do nothing;

  return v_result;
end;
$$;

grant execute on function public.get_ai_quiz_questions(text, text) to anon, authenticated;


-- ============================================================
-- OPTIONAL — run separately, read-only, to confirm the grant shape above
-- (quiz_user_seen_questions should show NO rows for anon/authenticated).
-- ============================================================
-- select table_name, grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name = 'quiz_user_seen_questions'
-- order by grantee, privilege_type;
