-- Phase C — guess-who answer cleanup + fuzzy matching + sub_category label.
-- Unlike most files in this directory, this one WAS applied directly via
-- the Supabase MCP connection this session (not "paste by hand") -- kept
-- here only as an audit-trail snapshot matching the convention of every
-- other file in this directory, and because ufc/quiz.js's normName/
-- buildAnswerVariants/isGuessCorrect comment points back at this file.

-- ============================================================
-- PART 1 — clean stored Football answers (category='Football' only).
-- Removes „ “ quotes and ' ’ apostrophes everywhere, and strips any
-- parenthetical that contains a Latin letter entirely (team/stadium
-- abbreviations and foreign-language aliases: (QPR), (RB Leipzig),
-- (FCSB), (Club Brugge), (KV Mechelen), (Hamburger SV), (IFK Göteborg),
-- (NSC Olimpiyskiy), (OAKA)). Georgian-only parentheticals are left
-- untouched (e.g. "სან სირო (ჯუზეპე მეაცა)"), and the bare answer "RCDE"
-- is unaffected (no quotes/apostrophes/parens to strip). UFC rows are
-- never touched (category filter) -- checked separately for Georgian
-- quote characters first, found none.
-- Idempotent: regexp_replace is deterministic, so re-running finds
-- nothing left to change.
begin;

update public.guess_who_questions
set answer = trim(both ' ' from
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(answer, '[„“]', '', 'g'),
      '[''’]', '', 'g'),
    '\s*\([^)]*[A-Za-z][^)]*\)', '', 'g'),
  '\s+', ' ', 'g')
)
where category = 'Football';

commit;

-- ============================================================
-- PART 2 — is_abbrev_hint column (display-only flag, never used to
-- filter/group the pool). The only guess-who answer that is a bare Latin
-- abbreviation is RCDE (Espanyol's stadium); PvP never sends answer text
-- to clients (anti-cheat, see quiz_group_pvp.sql), so the frontend needs
-- a non-revealing way to know "this one needs the abbreviation hint" --
-- sub_category alone is shared by every სტადიონი row.
-- ============================================================
alter table public.guess_who_questions
  add column if not exists is_abbrev_hint boolean not null default false;

update public.guess_who_questions
  set is_abbrev_hint = true
  where category = 'Football' and answer = 'RCDE';

-- ============================================================
-- PART 3 — fuzzy answer matching (both sports). Mirrors ufc/quiz.js's
-- normName/buildAnswerVariants/isGuessCorrect exactly -- keep both sides
-- in sync by hand, there is no shared source of truth. Used by
-- quiz_is_guess_correct, which submit_quiz_answer calls for PvP guess-who
-- scoring; the AI/local game path runs the equivalent JS instead.
-- ============================================================
create or replace function public.quiz_norm_name(s text)
 returns text
 language sql
 immutable
as $function$
  select trim(both ' ' from
    regexp_replace(
      regexp_replace(lower(coalesce(s, '')), '[„“"''’‘´`.,!?()\-–—]', '', 'g'),
    '\s+', ' ', 'g')
  );
$function$;

-- Builds the accepted-variant list for one stored answer: the full
-- normalized answer, the text outside/inside a single parenthetical (if
-- any), the last word alone, the answer with its leading word dropped, and
-- a handful of manual aliases for names that don't reduce to any of the
-- above (abbreviations, roman-numeral/arabic-numeral stadium names).
create or replace function public.quiz_build_answer_variants(p_answer text)
 returns text[]
 language plpgsql
 immutable
as $function$
declare
  v_full text;
  v_outside text;
  v_inside text;
  v_words text[];
  v_result text[] := '{}';
  v_paren_start int;
  v_paren_end int;
begin
  v_full := public.quiz_norm_name(p_answer);
  if v_full <> '' then
    v_result := array_append(v_result, v_full);
  end if;

  v_paren_start := position('(' in coalesce(p_answer, ''));
  v_paren_end := position(')' in coalesce(p_answer, ''));
  if v_paren_start > 0 and v_paren_end > v_paren_start then
    v_outside := public.quiz_norm_name(
      substring(p_answer from 1 for v_paren_start - 1) ||
      ' ' ||
      substring(p_answer from v_paren_end + 1)
    );
    v_inside := public.quiz_norm_name(
      substring(p_answer from v_paren_start + 1 for v_paren_end - v_paren_start - 1)
    );
  else
    v_outside := v_full;
    v_inside := '';
  end if;

  if v_outside <> '' and v_outside <> v_full then
    v_result := array_append(v_result, v_outside);
  end if;
  if v_inside <> '' then
    v_result := array_append(v_result, v_inside);
  end if;

  v_words := regexp_split_to_array(v_outside, '\s+');
  if coalesce(array_length(v_words, 1), 0) >= 1 then
    v_result := array_append(v_result, v_words[array_length(v_words, 1)]);
  end if;
  if coalesce(array_length(v_words, 1), 0) >= 2 then
    v_result := array_append(v_result, array_to_string(v_words[2:array_length(v_words, 1)], ' '));
  end if;

  if v_full = public.quiz_norm_name('ქუინზ პარკ რეინჯერსი') then
    v_result := array_append(v_result, public.quiz_norm_name('ქპრ'));
  elsif v_full = public.quiz_norm_name('RCDE') then
    v_result := array_append(v_result, public.quiz_norm_name('არსიდიი'));
    v_result := array_append(v_result, public.quiz_norm_name('არესიდიი'));
    v_result := array_append(v_result, public.quiz_norm_name('რცდე'));
  elsif v_full = public.quiz_norm_name('სტად ლუი II') then
    v_result := array_append(v_result, public.quiz_norm_name('სტად ლუი'));
    v_result := array_append(v_result, public.quiz_norm_name('სტად ლუი 2'));
  end if;

  return v_result;
end;
$function$;

-- ============================================================
-- PART 3b — RCDE now accepts four Georgian transliteration variants
-- (არსიდიი, არესიდიი, რცდე) instead of one. Re-running PART 3's
-- quiz_build_answer_variants above already reflects this (the elsif RCDE
-- branch was edited in place); this note is just the changelog entry.
-- ============================================================

-- Accept a guess if it matches ANY accepted variant at >=60% similarity;
-- variants of <=6 characters require a much stricter near-exact match
-- (otherwise short names like მესი/მესხი would cross-accept each other).
-- Falls back to a word-subset check (every word the player typed must
-- match some word drawn from the variants) so partial/typo'd multi-word
-- names (e.g. "ქვინს პარკი" for "ქუინზ პარკ რეინჯერსი") still pass -- but
-- only for guesses with >=2 real words, otherwise this fallback's flat
-- 60% per-word bound reopens the exact მესი/მესხი hole the strict
-- short-variant check above was added to close.
create or replace function public.quiz_is_guess_correct(p_guess text, p_answer text)
 returns boolean
 language plpgsql
 immutable
as $function$
declare
  g text := public.quiz_norm_name(p_guess);
  variants text[];
  v text;
  gw text;
  pw text;
  best numeric;
  all_match boolean := true;
  checked_count int := 0;
  pool_words text[] := '{}';
  guess_words text[];
begin
  if g = '' then return false; end if;

  variants := public.quiz_build_answer_variants(p_answer);

  foreach v in array variants loop
    if g = v then return true; end if;
  end loop;

  foreach v in array variants loop
    if length(v) <= 6 then
      if public.quiz_name_similarity(g, v) >= 0.84 then return true; end if;
    else
      if public.quiz_name_similarity(g, v) >= 0.6 then return true; end if;
    end if;
  end loop;

  foreach v in array variants loop
    pool_words := pool_words || regexp_split_to_array(v, '\s+');
  end loop;
  guess_words := regexp_split_to_array(g, '\s+');
  foreach gw in array guess_words loop
    if length(gw) < 2 then continue; end if;
    checked_count := checked_count + 1;
    best := 0;
    foreach pw in array pool_words loop
      if length(pw) < 2 then continue; end if;
      best := greatest(best, public.quiz_name_similarity(gw, pw));
    end loop;
    if best < 0.6 then
      all_match := false;
      exit;
    end if;
  end loop;
  if checked_count >= 2 and all_match then return true; end if;

  foreach v in array variants loop
    if length(g) >= 4 and (position(g in v) > 0 or position(v in g) > 0) then
      return true;
    end if;
  end loop;

  return false;
end;
$function$;

-- ============================================================
-- PART 4 — create_quiz_room (PvP room creation): the guess-who branch now
-- also selects/forwards sub_category and is_abbrev_hint per question, so
-- the dynamic answer-input label works in PvP too. Display-only; the
-- answer itself still never reaches the client here (unchanged). Only the
-- two added columns in the guess-who select lists and jsonb_build_object
-- calls differ from the pre-Phase-C version (see quiz_mixed_composition.sql
-- for the rest of this function's history).
-- ============================================================
create or replace function public.create_quiz_room(p_game_type text, p_level text, p_category text DEFAULT 'UFC'::text, p_guest_id text DEFAULT NULL::text, p_guest_name text DEFAULT NULL::text)
 returns TABLE(room_id uuid, code text, questions jsonb)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_player record;
  v_code text;
  v_room_id uuid;
  v_questions jsonb := '[]'::jsonb;
  v_key jsonb := '[]'::jsonb;
  v_row record;
  v_clues jsonb;
  v_tries int := 0;
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
    if v_mixed then
      for v_row in
        select * from (
          (select question, options, correct_index from public.quiz_questions
             where level = 'მარტივი' and category = p_category and is_active = true order by random() limit 3)
          union all
          (select question, options, correct_index from public.quiz_questions
             where level = 'საშუალო' and category = p_category and is_active = true order by random() limit 5)
          union all
          (select question, options, correct_index from public.quiz_questions
             where level = 'რთული' and category = p_category and is_active = true order by random() limit 2)
        ) z
        order by random()
      loop
        v_questions := v_questions || jsonb_build_array(jsonb_build_object('q', v_row.question, 'o', v_row.options));
        v_key := v_key || jsonb_build_array(v_row.correct_index);
      end loop;
    else
      for v_row in
        select question, options, correct_index
        from public.quiz_questions
        where level = p_level and category = p_category and is_active = true
        order by random()
        limit 10
      loop
        v_questions := v_questions || jsonb_build_array(jsonb_build_object('q', v_row.question, 'o', v_row.options));
        v_key := v_key || jsonb_build_array(v_row.correct_index);
      end loop;
    end if;
  else
    if v_mixed then
      for v_row in
        select * from (
          (select clue1, clue2, clue3, clue4, answer, sub_category, is_abbrev_hint from public.guess_who_questions
             where level = 'მარტივი' and category = p_category and is_active = true order by random() limit 3)
          union all
          (select clue1, clue2, clue3, clue4, answer, sub_category, is_abbrev_hint from public.guess_who_questions
             where level = 'საშუალო' and category = p_category and is_active = true order by random() limit 5)
          union all
          (select clue1, clue2, clue3, clue4, answer, sub_category, is_abbrev_hint from public.guess_who_questions
             where level = 'რთული' and category = p_category and is_active = true order by random() limit 2)
        ) z
        order by random()
      loop
        v_clues := '[]'::jsonb;
        if v_row.clue1 is not null and length(trim(v_row.clue1)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue1); end if;
        if v_row.clue2 is not null and length(trim(v_row.clue2)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue2); end if;
        if v_row.clue3 is not null and length(trim(v_row.clue3)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue3); end if;
        if v_row.clue4 is not null and length(trim(v_row.clue4)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue4); end if;
        v_questions := v_questions || jsonb_build_array(jsonb_build_object('clues', v_clues, 'sub_category', v_row.sub_category, 'is_abbrev_hint', v_row.is_abbrev_hint));
        v_key := v_key || jsonb_build_array(v_row.answer);
      end loop;
    else
      for v_row in
        select clue1, clue2, clue3, clue4, answer, sub_category, is_abbrev_hint
        from public.guess_who_questions
        where level = p_level and category = p_category and is_active = true
        order by random()
        limit 10
      loop
        v_clues := '[]'::jsonb;
        if v_row.clue1 is not null and length(trim(v_row.clue1)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue1); end if;
        if v_row.clue2 is not null and length(trim(v_row.clue2)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue2); end if;
        if v_row.clue3 is not null and length(trim(v_row.clue3)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue3); end if;
        if v_row.clue4 is not null and length(trim(v_row.clue4)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue4); end if;
        v_questions := v_questions || jsonb_build_array(jsonb_build_object('clues', v_clues, 'sub_category', v_row.sub_category, 'is_abbrev_hint', v_row.is_abbrev_hint));
        v_key := v_key || jsonb_build_array(v_row.answer);
      end loop;
    end if;
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

  insert into public.quiz_room_players (room_id, player_id, player_name, is_host)
    values (v_room_id, v_player.player_id, v_player.player_name, true);

  return query select v_room_id, v_code, v_questions;
end;
$function$;
