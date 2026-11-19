-- Phase C — შერეული (mixed) composition fix.
-- NOT auto-applied -- paste into the Supabase SQL editor by hand (same
-- convention as every other file in this directory).
--
-- Problem: get_ai_quiz_questions and create_quiz_room both treat
-- p_level = 'შერეული' as "drop the level filter, order by random() limit
-- 10" -- a flat random pull across all three levels, with no guaranteed
-- composition. The product requirement is a fixed 3 მარტივი + 5 საშუალო +
-- 2 რთული split (randomly chosen *within* each level), applied identically
-- to UFC and Football, and to both quiz and guess-who. Since both game
-- types and both categories already flow through these same two shared
-- functions (game_type/category are just parameters), fixing the mixed
-- branch here covers all four combinations in one place.
--
-- get_ai_quiz_questions (vs-AI, no-repeat tracked):
--   The existing no-repeat reset check only compared the *combined* mixed
--   pool (all three levels together) against a single <10-remaining
--   threshold. That's wrong for a 3/5/2 split: UFC's guess-who level pools
--   are small (მარტივი/საშუალო/რთული = 18/24/18 rows today) and a user who
--   replays mixed games enough times can exhaust one sub-level (e.g.
--   საშუალო, 5 needed per game) while the *combined* remaining count still
--   looks nowhere near the old threshold. So each sub-level's no-repeat
--   history is now checked/reset independently before the pick.
--
-- create_quiz_room (PvP room creation): never touches
-- quiz_user_seen_questions (confirmed existing behavior, PvP rooms are
-- intentionally always-fresh-random for every player to share one set) --
-- so its mixed branch is just the plain 3/5/2 union, no reset logic needed.
--
-- Non-mixed (single-level) behavior is untouched in both functions.

-- ============================================================
-- BLOCK 1 (read-only) -- sanity check before applying: confirm every
-- level pool for every live category is big enough to satisfy 3/5/2 with
-- room to spare, so the per-sub-level reset in get_ai_quiz_questions can
-- never find itself stuck.
-- ============================================================
select category, level, count(*) as active_rows
from public.quiz_questions
where is_active = true
group by category, level
order by category, level;

select category, level, count(*) as active_rows
from public.guess_who_questions
where is_active = true
group by category, level
order by category, level;

-- ============================================================
-- BLOCK 2 -- replace both functions.
-- ============================================================

create or replace function public.get_ai_quiz_questions(p_game_type text, p_level text, p_category text default 'UFC'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid   uuid := auth.uid();
  v_total int;
  v_seen  int;
  v_result jsonb;
  v_mixed boolean := (p_level = 'შერეული');
  v_sub record;
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

  if v_mixed then
    -- 3 მარტივი + 5 საშუალო + 2 რთული, each sub-level's no-repeat history
    -- reset independently if it's about to run dry (see header comment).
    for v_sub in select * from (values ('მარტივი',3),('საშუალო',5),('რთული',2)) as t(lvl, need)
    loop
      if p_game_type = 'quiz' then
        select count(*) into v_total from public.quiz_questions
          where level = v_sub.lvl and category = p_category and is_active = true;
        select count(*) into v_seen from public.quiz_user_seen_questions sq
          join public.quiz_questions q on q.id::text = sq.question_id
          where sq.user_id = v_uid and sq.game_type = p_game_type and sq.level = p_level
            and sq.category = p_category and q.level = v_sub.lvl;
        if (v_total - v_seen) < v_sub.need then
          delete from public.quiz_user_seen_questions sq
            using public.quiz_questions q
            where sq.question_id = q.id::text and q.level = v_sub.lvl
              and sq.user_id = v_uid and sq.game_type = p_game_type and sq.level = p_level and sq.category = p_category;
        end if;
      else
        select count(*) into v_total from public.guess_who_questions
          where level = v_sub.lvl and category = p_category and is_active = true;
        select count(*) into v_seen from public.quiz_user_seen_questions sq
          join public.guess_who_questions q on q.id::text = sq.question_id
          where sq.user_id = v_uid and sq.game_type = p_game_type and sq.level = p_level
            and sq.category = p_category and q.level = v_sub.lvl;
        if (v_total - v_seen) < v_sub.need then
          delete from public.quiz_user_seen_questions sq
            using public.guess_who_questions q
            where sq.question_id = q.id::text and q.level = v_sub.lvl
              and sq.user_id = v_uid and sq.game_type = p_game_type and sq.level = p_level and sq.category = p_category;
        end if;
      end if;
    end loop;

    if p_game_type = 'quiz' then
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
      from (
        select * from (
          (select * from public.quiz_questions
             where level = 'მარტივი' and category = p_category and is_active = true
               and id::text not in (select question_id from public.quiz_user_seen_questions
                 where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category)
             order by random() limit 3)
          union all
          (select * from public.quiz_questions
             where level = 'საშუალო' and category = p_category and is_active = true
               and id::text not in (select question_id from public.quiz_user_seen_questions
                 where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category)
             order by random() limit 5)
          union all
          (select * from public.quiz_questions
             where level = 'რთული' and category = p_category and is_active = true
               and id::text not in (select question_id from public.quiz_user_seen_questions
                 where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category)
             order by random() limit 2)
        ) x
        order by random()
      ) t;
    else
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
      from (
        select * from (
          (select * from public.guess_who_questions
             where level = 'მარტივი' and category = p_category and is_active = true
               and id::text not in (select question_id from public.quiz_user_seen_questions
                 where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category)
             order by random() limit 3)
          union all
          (select * from public.guess_who_questions
             where level = 'საშუალო' and category = p_category and is_active = true
               and id::text not in (select question_id from public.quiz_user_seen_questions
                 where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category)
             order by random() limit 5)
          union all
          (select * from public.guess_who_questions
             where level = 'რთული' and category = p_category and is_active = true
               and id::text not in (select question_id from public.quiz_user_seen_questions
                 where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category)
             order by random() limit 2)
        ) x
        order by random()
      ) t;
    end if;

  else
    -- Non-mixed: unchanged single-level behavior.
    if p_game_type = 'quiz' then
      select count(*) into v_total from public.quiz_questions
        where level = p_level and category = p_category and is_active = true;
    else
      select count(*) into v_total from public.guess_who_questions
        where level = p_level and category = p_category and is_active = true;
    end if;

    if v_total = 0 then
      raise exception 'no questions available for % / % / %', p_game_type, p_level, p_category;
    end if;

    select count(*) into v_seen
      from public.quiz_user_seen_questions
      where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category;

    if (v_total - v_seen) < 10 then
      delete from public.quiz_user_seen_questions
        where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category;
    end if;

    if p_game_type = 'quiz' then
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
      from (
        select * from public.quiz_questions
        where level = p_level and category = p_category and is_active = true
          and id::text not in (
            select question_id from public.quiz_user_seen_questions
            where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category
          )
        order by random()
        limit 10
      ) t;
    else
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
      from (
        select * from public.guess_who_questions
        where level = p_level and category = p_category and is_active = true
          and id::text not in (
            select question_id from public.quiz_user_seen_questions
            where user_id = v_uid and game_type = p_game_type and level = p_level and category = p_category
          )
        order by random()
        limit 10
      ) t;
    end if;
  end if;

  if v_result is null or jsonb_array_length(v_result) = 0 then
    raise exception 'no questions available for % / % / %', p_game_type, p_level, p_category;
  end if;

  insert into public.quiz_user_seen_questions (user_id, game_type, level, category, question_id, seen_at)
  select v_uid, p_game_type, p_level, p_category, (elem ->> 'id'), now()
  from jsonb_array_elements(v_result) elem
  on conflict (user_id, game_type, level, category, question_id) do nothing;

  return v_result;
end;
$function$;

create or replace function public.create_quiz_room(p_game_type text, p_level text, p_category text default 'UFC'::text, p_guest_id text default null::text, p_guest_name text default null::text)
 returns table(room_id uuid, code text, questions jsonb)
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
          (select clue1, clue2, clue3, clue4, answer from public.guess_who_questions
             where level = 'მარტივი' and category = p_category and is_active = true order by random() limit 3)
          union all
          (select clue1, clue2, clue3, clue4, answer from public.guess_who_questions
             where level = 'საშუალო' and category = p_category and is_active = true order by random() limit 5)
          union all
          (select clue1, clue2, clue3, clue4, answer from public.guess_who_questions
             where level = 'რთული' and category = p_category and is_active = true order by random() limit 2)
        ) z
        order by random()
      loop
        v_clues := '[]'::jsonb;
        if v_row.clue1 is not null and length(trim(v_row.clue1)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue1); end if;
        if v_row.clue2 is not null and length(trim(v_row.clue2)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue2); end if;
        if v_row.clue3 is not null and length(trim(v_row.clue3)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue3); end if;
        if v_row.clue4 is not null and length(trim(v_row.clue4)) > 0 then v_clues := v_clues || jsonb_build_array(v_row.clue4); end if;
        v_questions := v_questions || jsonb_build_array(jsonb_build_object('clues', v_clues));
        v_key := v_key || jsonb_build_array(v_row.answer);
      end loop;
    else
      for v_row in
        select clue1, clue2, clue3, clue4, answer
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
        v_questions := v_questions || jsonb_build_array(jsonb_build_object('clues', v_clues));
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
