-- ============================================================
--  quiz_no_repeat.sql — UFC Quiz Phase Q1 (no-repeat questions, vs-AI only)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom. Safe to re-run —
--  every statement is IF NOT EXISTS / OR REPLACE.
--
--  Scope: vs-AI quiz + guess-who only (PRD §1.1). PvP rooms are untouched —
--  they keep generating a fully random question set per room, since every
--  player in a room needs the SAME shared set at the same time.
--
--  ── ID-COLUMN UNCERTAINTY (please read before running) ──
--  This repo stores no SQL migrations (see CLAUDE.md), so I could not
--  confirm live whether `quiz_questions` / `guess_who_questions` already
--  have a stable `id` column, and no code in this repo references `.id`
--  on either table — `quiz_pvp.sql` selects specific columns by name only
--  (question/options/correct_index, clue1..4/answer), never `id`, and
--  ufc/quiz.js uses `select('*')` + a tolerant normalizer that never looks
--  for `id` either. My confidence that a usable `id` already exists is
--  LOW — plausible (Supabase's table-creator UI defaults to one) but
--  unverified.
--
--  To stay safe either way, the ALTER TABLE statements below are fully
--  defensive and work whether or not an `id` column already exists:
--    - `ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid()` is a
--      no-op if a column named `id` already exists, REGARDLESS of its
--      type — Postgres only checks the name, not the type, for
--      IF NOT EXISTS. So an existing bigint/int8 `id` is left completely
--      untouched; nothing here can corrupt or retype it.
--    - If no `id` column exists yet, this adds a uuid one, backfills it,
--      and makes it NOT NULL.
--    - A unique index (not a PRIMARY KEY constraint) is added on `id` —
--      IF NOT EXISTS, and naming it separately from any existing PK means
--      it can never collide with a PK that already exists on `id` or any
--      other column.
--  The new quiz_user_seen_questions.question_id column below is `text`,
--  not `uuid`/`bigint` and carries NO foreign key — this is deliberate so
--  it works identically whether the real `id` on either table turns out
--  to be uuid or bigint (we just cast whatever it is to text). After
--  running, please check in the dashboard whether `quiz_questions.id` /
--  `guess_who_questions.id` already existed before this file touched them
--  (Table Editor -> column list), and tell me — if they didn't, this is
--  the first time those rows have a stable identity, worth knowing.
--
--  What this does, in order:
--   1. Defensively ensures `id` exists + is unique on quiz_questions and
--      guess_who_questions (see note above).
--   2. Creates quiz_user_seen_questions — RLS on, ZERO grants to
--      anon/authenticated, same pattern as quiz_room_keys in quiz_pvp.sql
--      (access only through the SECURITY DEFINER RPC below, which runs as
--      `postgres` and bypasses RLS as the table owner).
--   3. Creates get_ai_quiz_questions(p_game_type, p_level) — the one RPC
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
-- 1) DEFENSIVE id COLUMN on quiz_questions / guess_who_questions
-- ============================================================
alter table public.quiz_questions
  add column if not exists id uuid default gen_random_uuid();
update public.quiz_questions set id = gen_random_uuid() where id is null;
alter table public.quiz_questions alter column id set not null;
create unique index if not exists quiz_questions_id_uq on public.quiz_questions(id);

alter table public.guess_who_questions
  add column if not exists id uuid default gen_random_uuid();
update public.guess_who_questions set id = gen_random_uuid() where id is null;
alter table public.guess_who_questions alter column id set not null;
create unique index if not exists guess_who_questions_id_uq on public.guess_who_questions(id);


-- ============================================================
-- 2) TABLE — quiz_user_seen_questions
-- ============================================================
create table if not exists public.quiz_user_seen_questions (
  user_id     uuid not null,
  game_type   text not null check (game_type in ('quiz','guess')),
  level       text not null,
  question_id text not null,   -- cast-to-text copy of quiz_questions.id / guess_who_questions.id — see note above on why not a typed FK
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
-- 3) RPC — get_ai_quiz_questions
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
