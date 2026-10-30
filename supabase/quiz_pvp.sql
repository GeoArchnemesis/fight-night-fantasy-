-- ============================================================
--  quiz_pvp.sql — UFC Quiz Phase 3 (invite-a-friend by code, PvP)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom. Safe to re-run
--  over the version you already deployed — everything is IF NOT EXISTS /
--  OR REPLACE and no signatures changed.
--
--  UPDATE (QuizUpdates.pdf): login is now required to play at all (quiz
--  AND PvP). This is enforced in quiz_resolve_player() below, not only in
--  the frontend — an anonymous caller now gets a clean "authentication
--  required" error from every RPC, regardless of what the client sends.
--  The guest-identity path (p_guest_id/p_guest_name) is gone in practice;
--  the parameters are kept on every RPC signature (now ignored) purely so
--  this stays a signature-compatible CREATE OR REPLACE, not a DROP+CREATE.
--
--  What this does, in order:
--   1. Enables the `fuzzystrmatch` extension (Postgres's levenshtein(),
--      used for guess-who fuzzy scoring on the server).
--   2. Creates 3 new tables: quiz_rooms, quiz_room_keys, quiz_room_answers.
--   3. Enables RLS on all three. quiz_rooms gets a permissive SELECT
--      policy (nothing secret lives in it — see the anti-cheat note
--      below) so Realtime + direct status polling both work. The other
--      two tables get ZERO grants and ZERO policies for anon/authenticated
--      — every read or write on them happens through the SECURITY
--      DEFINER RPCs below, which run as `postgres` and — since `postgres`
--      owns these tables and FORCE ROW LEVEL SECURITY is never set —
--      bypass RLS automatically, exactly like the known-good
--      soccer_matches pattern noted in CLAUDE.md.
--   4. Creates helper functions (Georgian-aware fuzzy name match, a
--      6-character room-code generator, and an identity resolver that
--      prefers a real auth.uid() session and falls back to a
--      client-supplied guest id) and the 7 RPCs the frontend calls.
--   5. Adds quiz_rooms to the `supabase_realtime` publication (safe to
--      re-run — it checks first) and sets REPLICA IDENTITY FULL on it
--      so Realtime payloads carry full row data.
--
--  ── ANTI-CHEAT DESIGN (please read before running) ──
--  The correct answer for every question is NEVER stored anywhere the
--  client can read it before the reveal:
--    - `quiz_rooms.questions` holds ONLY question text + options (quiz)
--      or clues (guess-who) — no correct_index, no answer text. This is
--      the one table anon/authenticated CAN select directly (needed for
--      Realtime), and it is safe to expose in full because the answer
--      simply isn't in it.
--    - The real answer key lives only in `quiz_room_keys`, which has no
--      grants and no RLS policy for anon/authenticated at all — not even
--      column-restricted access, a full table-level deny. This matters
--      because Supabase Realtime's `postgres_changes` broadcasts the
--      FULL row to anyone whose RLS lets the row through, bypassing any
--      column-level GRANT — so the only airtight way to keep the key off
--      the wire is to never enable Realtime (or any grant) on the table
--      that holds it at all. That's why the key sits in its own table
--      instead of a second column on quiz_rooms.
--    - `quiz_room_answers` (raw picks + server-computed points) also has
--      zero direct grants, so one player can never read the other's pick
--      before both have answered — reveal only happens through
--      `get_quiz_results`, which checks `status = 'finished'` first.
--    - Scoring is 100% server-side: `submit_quiz_answer` takes the raw
--      pick only, looks up the real key itself, and computes points.
--    - Guess-who's "how many clues did you use" scoring multiplier is
--      ALSO tracked server-side (`reveal_quiz_clue`, `clues_shown` column)
--      rather than trusting a client-reported count — otherwise a
--      modified client could always claim "1 clue" and farm max points
--      on every correct guess.
--
--  Safe to re-run: every CREATE TABLE/FUNCTION uses IF NOT EXISTS / OR
--  REPLACE, and the publication step checks before adding.
--
--  After running, I'd suggest verifying in the dashboard:
--   - Table Editor -> quiz_room_keys and quiz_room_answers: confirm
--     "anon" and "authenticated" show NO checkmarks under any privilege.
--   - Database -> Replication: confirm quiz_rooms is listed under the
--     supabase_realtime publication.
--   - The read-only sanity-check query at the very bottom of this file.
--
--  ── ONE CAVEAT TO ACTUALLY TEST ──
--  The guess-who fuzzy-match reuses Postgres's levenshtein() (from
--  fuzzystrmatch) on Georgian text. Exact-match and the substring-
--  containment fallback do NOT depend on levenshtein() and are solid
--  regardless of encoding; only the "tolerate a few misspelled letters"
--  tier depends on levenshtein() behaving correctly on multi-byte UTF-8
--  Georgian text, which I could not verify in my sandbox (no Postgres
--  available there). Please test one slightly-misspelled Georgian guess
--  in a real PvP match — if it scores oddly, tell me and I'll swap that
--  one tier for a simpler check instead of levenshtein().
--
--  Keep in sync with ufc/quiz.js if you ever change these: questions per
--  game (currently 10, hardcoded as `limit 10` below) and the guess-who
--  fuzzy-match thresholds (0.65 / 0.62) in isGuessCorrect().
-- ============================================================


-- ============================================================
-- 0) EXTENSION
-- ============================================================
create extension if not exists fuzzystrmatch;


-- ============================================================
-- 1) TABLES
-- ============================================================

create table if not exists public.quiz_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  game_type text not null check (game_type in ('quiz','guess')),
  level text not null,
  status text not null default 'waiting' check (status in ('waiting','active','finished','abandoned')),
  host_id text not null,
  host_name text not null,
  guest_id text,
  guest_name text,
  questions jsonb not null,          -- DISPLAY ONLY — never contains a correct answer, see note above
  host_finished_at timestamptz,
  guest_finished_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz
);

create table if not exists public.quiz_room_keys (
  room_id uuid primary key references public.quiz_rooms(id) on delete cascade,
  answer_key jsonb not null          -- SECRET — correct_index per question (quiz) or correct answer text (guess)
);

create table if not exists public.quiz_room_answers (
  room_id uuid not null references public.quiz_rooms(id) on delete cascade,
  player_id text not null,
  question_index int not null,
  clues_shown int not null default 1,  -- server-tracked (reveal_quiz_clue); only meaningful for game_type='guess'
  pick jsonb,                           -- null until actually submitted (a reveal-only row has pick = null)
  points int not null default 0,
  answered_at timestamptz,
  primary key (room_id, player_id, question_index)
);

alter table public.quiz_rooms replica identity full;


-- ============================================================
-- 2) RLS + GRANTS
-- ============================================================
alter table public.quiz_rooms enable row level security;
alter table public.quiz_room_keys enable row level security;
alter table public.quiz_room_answers enable row level security;

-- quiz_rooms: nothing secret in this table (see anti-cheat note above) —
-- safe for anyone holding the anon key to read any row. This is what lets
-- Realtime deliver status changes (waiting -> active -> finished) and lets
-- a client do a plain `select` for lightweight polling as a Realtime
-- fallback. No write policies at all: every write goes through the
-- SECURITY DEFINER RPCs below.
drop policy if exists quiz_rooms_select_all on public.quiz_rooms;
create policy quiz_rooms_select_all on public.quiz_rooms for select using (true);

grant select on public.quiz_rooms to anon, authenticated;
grant all on public.quiz_rooms to service_role;

-- quiz_room_keys / quiz_room_answers: anon/authenticated get NO grant and
-- NO policy at all. With RLS enabled and no policy, access is denied by
-- default even if a grant existed; with no grant either, PostgREST refuses
-- the request outright. service_role (and the RPCs, running as the table
-- owner `postgres`) are the only path in or out.
grant all on public.quiz_room_keys to service_role;
grant all on public.quiz_room_answers to service_role;


-- ============================================================
-- 3) HELPERS
-- ============================================================

create or replace function public.quiz_norm_name(s text) returns text
language sql immutable as $$
  select trim(both ' ' from
    regexp_replace(
      regexp_replace(lower(coalesce(s, '')), '[''"’‘´`.,!?()\-–—]', '', 'g'),
    '\s+', ' ', 'g')
  );
$$;

create or replace function public.quiz_name_similarity(a text, b text) returns numeric
language sql immutable as $$
  select case
    when length(a) = 0 and length(b) = 0 then 1::numeric
    else 1 - (levenshtein(a, b)::numeric / greatest(length(a), length(b)))
  end;
$$;

-- Mirrors ufc/quiz.js's isGuessCorrect(): exact match, then space/
-- punctuation-insensitive match, then whole-string similarity, then
-- word-by-word similarity, then substring containment (surname-only).
-- Keep thresholds (0.65 / 0.62) in sync with quiz.js if you ever tune them.
create or replace function public.quiz_is_guess_correct(p_guess text, p_answer text) returns boolean
language plpgsql immutable as $$
declare
  g text := public.quiz_norm_name(p_guess);
  a text := public.quiz_norm_name(p_answer);
  g_c text;
  a_c text;
  aw text;
  gw text;
  best numeric;
  all_match boolean := true;
  any_a_word boolean := false;
begin
  if g = '' then return false; end if;
  if g = a then return true; end if;

  g_c := regexp_replace(g, '\s+', '', 'g');
  a_c := regexp_replace(a, '\s+', '', 'g');
  if g_c = a_c then return true; end if;

  if public.quiz_name_similarity(g_c, a_c) >= 0.65 then return true; end if;

  for aw in select unnest(string_to_array(a, ' ')) loop
    if length(aw) < 2 then continue; end if;
    any_a_word := true;
    best := 0;
    for gw in select unnest(string_to_array(g, ' ')) loop
      if length(gw) < 2 then continue; end if;
      best := greatest(best, public.quiz_name_similarity(gw, aw));
    end loop;
    if best < 0.62 then
      all_match := false;
      exit;
    end if;
  end loop;
  if any_a_word and all_match then return true; end if;

  if length(g_c) >= 4 and (position(g_c in a_c) > 0 or position(a_c in g_c) > 0) then
    return true;
  end if;

  return false;
end;
$$;

-- Short, unambiguous room codes — excludes 0/O/1/I so they're easy to read
-- aloud/type on a phone. The alphabet is 31 characters, so floor() is
-- required here, not a plain ::int cast: ::int on a numeric/float value
-- rounds to the nearest integer rather than truncating, so random() * 31
-- (which ranges over [0, 31)) can round up to 31, making the index 32 and
-- substr() return an empty string for that position, silently dropping a
-- character from the code. floor(random() * 31)::int truncates instead, so
-- it only ever produces 0 through 30, giving a uniform 1 to 31 index.
create or replace function public.quiz_gen_code() returns text
language sql volatile as $$
  select string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', floor(random() * 31)::int + 1, 1), '')
  from generate_series(1, 6);
$$;

-- UPDATE (QuizUpdates.pdf): login is now required to play at all, enforced
-- here — not just in the client UI — so this is the real security boundary,
-- not a suggestion. p_guest_id/p_guest_name are kept as accepted-but-ignored
-- parameters (so every other RPC's signature below needs no change, and
-- CREATE OR REPLACE stays a clean in-place swap) but guest play no longer
-- exists: a caller with no auth.uid() session is rejected outright.
create or replace function public.quiz_resolve_player(p_guest_id text, p_guest_name text)
returns table(player_id text, player_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_nick text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  select nick into v_nick from public.users where id = v_uid;
  return query select v_uid::text, coalesce(nullif(trim(v_nick), ''), 'მოთამაშე');
end;
$$;


-- ============================================================
-- 4) RPCs — all SECURITY DEFINER, owned by postgres (CLAUDE.md's
--    known-good pattern: service_role/owner full access, anon/
--    authenticated reach everything only through these functions).
-- ============================================================

create or replace function public.create_quiz_room(
  p_game_type text, p_level text, p_guest_id text default null, p_guest_name text default null
) returns table(room_id uuid, code text)
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

  return query select v_room_id, v_code;
end;
$$;

create or replace function public.join_quiz_room(
  p_code text, p_guest_id text default null, p_guest_name text default null
) returns table(room_id uuid, game_type text, level text, questions jsonb, host_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
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
  if v_room.status <> 'waiting' then
    raise exception 'room already full or finished';
  end if;
  if v_room.host_id = v_player.player_id then
    raise exception 'cannot join your own room';
  end if;

  update public.quiz_rooms
    set guest_id = v_player.player_id, guest_name = v_player.player_name,
        status = 'active', started_at = now()
    where id = v_room.id;

  return query select v_room.id, v_room.game_type, v_room.level, v_room.questions, v_room.host_name;
end;
$$;

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
  if v_player.player_id not in (v_room.host_id, coalesce(v_room.guest_id, '')) then
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
  v_is_host boolean;
  v_answered_count int;
  v_total int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'active' then raise exception 'room not active'; end if;

  v_is_host := (v_player.player_id = v_room.host_id);
  if not v_is_host and v_player.player_id <> coalesce(v_room.guest_id, '') then
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
    if v_is_host then
      update public.quiz_rooms set host_finished_at = coalesce(host_finished_at, now()) where id = p_room_id;
    else
      update public.quiz_rooms set guest_finished_at = coalesce(guest_finished_at, now()) where id = p_room_id;
    end if;

    update public.quiz_rooms
      set status = 'finished'
      where id = p_room_id
        and host_finished_at is not null
        and guest_finished_at is not null
        and status <> 'finished';
  end if;
end;
$$;

create or replace function public.get_quiz_results(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(
  game_type text, level text,
  host_name text, guest_name text,
  host_picks jsonb, guest_picks jsonb,
  host_points jsonb, guest_points jsonb,
  answer_key jsonb
)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_player.player_id not in (v_room.host_id, coalesce(v_room.guest_id, '')) then
    raise exception 'not a participant';
  end if;
  if v_room.status <> 'finished' then
    raise exception 'room not finished yet';
  end if;

  return query
  select
    v_room.game_type, v_room.level, v_room.host_name, v_room.guest_name,
    (select coalesce(jsonb_object_agg(question_index, pick), '{}'::jsonb)
       from public.quiz_room_answers where room_id = p_room_id and player_id = v_room.host_id),
    (select coalesce(jsonb_object_agg(question_index, pick), '{}'::jsonb)
       from public.quiz_room_answers where room_id = p_room_id and player_id = v_room.guest_id),
    (select coalesce(jsonb_object_agg(question_index, points), '{}'::jsonb)
       from public.quiz_room_answers where room_id = p_room_id and player_id = v_room.host_id),
    (select coalesce(jsonb_object_agg(question_index, points), '{}'::jsonb)
       from public.quiz_room_answers where room_id = p_room_id and player_id = v_room.guest_id),
    (select quiz_room_keys.answer_key from public.quiz_room_keys where room_id = p_room_id);
end;
$$;

create or replace function public.rejoin_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(
  status text, code text, game_type text, level text, questions jsonb,
  host_name text, guest_name text, answered_indexes int[]
)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_answered int[];
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_player.player_id not in (v_room.host_id, coalesce(v_room.guest_id, '')) then
    raise exception 'not a participant';
  end if;
  if v_room.status = 'abandoned' then
    raise exception 'room abandoned';
  end if;

  select coalesce(array_agg(question_index order by question_index), array[]::int[])
    into v_answered
    from public.quiz_room_answers
    where room_id = p_room_id and player_id = v_player.player_id and answered_at is not null;

  return query select v_room.status, v_room.code, v_room.game_type, v_room.level, v_room.questions,
                      v_room.host_name, v_room.guest_name, v_answered;
end;
$$;

create or replace function public.leave_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id;
  if not found then return; end if;  -- already gone, nothing to do
  if v_player.player_id not in (v_room.host_id, coalesce(v_room.guest_id, '')) then
    raise exception 'not a participant';
  end if;
  if v_room.status in ('waiting', 'active') then
    update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
  end if;
end;
$$;

grant execute on function public.create_quiz_room(text, text, text, text) to anon, authenticated;
grant execute on function public.join_quiz_room(text, text, text) to anon, authenticated;
grant execute on function public.reveal_quiz_clue(uuid, int, text, text) to anon, authenticated;
grant execute on function public.submit_quiz_answer(uuid, int, jsonb, text, text) to anon, authenticated;
grant execute on function public.get_quiz_results(uuid, text, text) to anon, authenticated;
grant execute on function public.rejoin_quiz_room(uuid, text, text) to anon, authenticated;
grant execute on function public.leave_quiz_room(uuid, text, text) to anon, authenticated;


-- ============================================================
-- 5) REALTIME — add quiz_rooms to the publication (idempotent)
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'quiz_rooms'
  ) then
    alter publication supabase_realtime add table public.quiz_rooms;
  end if;
end $$;


-- ============================================================
-- OPTIONAL — run separately, read-only, to confirm the grant shape above
-- matches what's described in the anti-cheat note (quiz_room_keys and
-- quiz_room_answers should show NO rows for anon/authenticated at all).
-- ============================================================
-- select table_name, grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('quiz_rooms', 'quiz_room_keys', 'quiz_room_answers')
-- order by table_name, grantee, privilege_type;
