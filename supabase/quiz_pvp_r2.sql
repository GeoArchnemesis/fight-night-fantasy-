-- ============================================================
--  quiz_pvp_r2.sql — Phase R2 (MoreUpdatesOct.pdf p1, p9)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom, AFTER
--  quiz_group_pvp.sql (this file replaces two of its functions and adds
--  one new one). Safe to re-run.
--
--  What this does, in order:
--   1. NEW RPC get_quiz_room_player_avatars(p_room_id) — lets the lobby
--      and podium show each player's real avatar_url/icon instead of a
--      hardcoded emoji (PDF p1). quiz_room_players.player_id is `text`,
--      not an FK to users.id, so PostgREST can't auto-embed this join —
--      and a direct `select ... from users where id in (...)` from the
--      client would return nothing for anyone but yourself, since `users`
--      SELECT is (almost certainly, per the same reasoning as
--      get_public_profile in profile_redesign.sql) restricted to
--      auth.uid() = id. This RPC is the narrow, safe equivalent: SECURITY
--      DEFINER, returns ONLY icon/avatar_url/avatar_type (no bio/phone/
--      balance/etc.), and only for players who are actually in the room
--      the caller is themselves a participant of — not a general
--      "look up any user's avatar by id" capability.
--   2. get_quiz_results — CREATE OR REPLACE, same outer return columns
--      (game_type, level, players, answer_key) so no DROP needed; each
--      object inside the `players` jsonb array now also carries icon/
--      avatar_url/avatar_type, via the same safe join pattern as the new
--      RPC above, so the podium (PDF p1) can show a real photo/icon
--      inside the gold/silver/bronze ring instead of a medal emoji.
--   3. leave_quiz_room — CREATE OR REPLACE, same signature (void). Adds
--      one new case to the existing 'active'-room branch: if removing the
--      leaving player brings the room down to EXACTLY ONE remaining
--      player, that player is declared the winner immediately — status
--      flips straight to 'finished' with whatever score they have so far,
--      even if they haven't answered all 10 questions yet (PDF p9: "an
--      active quiz would otherwise never end, and the user would have to
--      wait forever"). This only applies to 'active' rooms — a 'waiting'
--      lobby going down to 1 player (the host, before anyone else has
--      joined, or after a friend leaves pre-start) is the NORMAL starting
--      state of every room and must NOT trigger a win; that branch is
--      untouched. The existing 0-remaining-players abandon logic and the
--      existing bool_and "did everyone finish" check (for 2+ remaining)
--      are both unchanged.
--
--  Keep in sync with ufc/quiz.js if you ever change this: both new
--  avatar-related pieces are consumed by pvpAvatarHtml()/renderPvpResults()
--  there.
-- ============================================================


-- ============================================================
-- 1) RPC — get_quiz_room_player_avatars (NEW)
-- ============================================================
create or replace function public.get_quiz_room_player_avatars(p_room_id uuid)
returns table(player_id text, icon text, avatar_url text, avatar_type text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from public.quiz_room_players
    where room_id = p_room_id and player_id = v_uid::text
  ) then
    raise exception 'not a participant';
  end if;

  return query
    select qp.player_id, u.icon, u.avatar_url, u.avatar_type
    from public.quiz_room_players qp
    join public.users u on u.id::text = qp.player_id
    where qp.room_id = p_room_id;
end;
$$;

grant execute on function public.get_quiz_room_player_avatars(uuid) to authenticated;


-- ============================================================
-- 2) RPC — get_quiz_results (adds icon/avatar_url/avatar_type per player)
-- ============================================================
create or replace function public.get_quiz_results(
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
-- 3) RPC — leave_quiz_room (adds "last player standing wins" for active rooms)
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
    elsif v_remaining = 1 then
      -- PDF p9: everyone else left an in-progress game — declare the one
      -- remaining player the winner right away with whatever score they
      -- have so far, rather than leaving them waiting on a room that can
      -- now never reach "everyone finished" on its own.
      update public.quiz_rooms set status = 'finished' where id = p_room_id and status <> 'finished';
    else
      -- The player who just left might have been the last unfinished one
      -- among 2+ remaining — recheck, otherwise the room could get stuck
      -- 'active' forever with nothing left to trigger the finish check in
      -- submit_quiz_answer.
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
-- OPTIONAL — run separately, read-only, sanity check
-- ============================================================
-- confirm get_quiz_room_player_avatars only returns icon/avatar_url/avatar_type
-- (no bio/phone/balance/etc.) by checking its definition:
-- select pg_get_functiondef('public.get_quiz_room_player_avatars(uuid)'::regprocedure);
