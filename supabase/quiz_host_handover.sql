-- ============================================================
--  quiz_host_handover.sql — fix leave_quiz_room so host handover also
--  updates quiz_room_players.is_host, not just quiz_rooms.host_id
--  APPLIED. This file has been run in full against the live Supabase
--  project (qxfcwsiysnjxhxljqigl) via MCP. Idempotent and safe to
--  re-run — it is a single CREATE OR REPLACE plus its grant, no DROP.
--  Applied 2026-11-07.
--
--  THE PROBLEM:
--  leave_quiz_room (supabase/quiz_leave_v2.sql, section E) hands the host
--  role over by updating quiz_rooms.host_id only, in both the 'waiting'
--  and 'active' branches. It never touches quiz_room_players.is_host —
--  and the client reads is_host from that table (ufc/quiz.js
--  renderPvpLobbyList) to decide who sees the "დაწყება" (start) button.
--  So after the host leaves, no row in quiz_room_players has is_host =
--  true, no player is shown as host, and the start button never appears
--  for anyone — the room is stuck.
--
--  THE FIX:
--  Same signature, same body as the live/repo version, except both host
--  handover branches now also set is_host = true on the new host's row
--  and is_host = false on every other row in the room, right alongside
--  the existing quiz_rooms.host_id update. Nothing else in the function
--  changes.
-- ============================================================

create or replace function public.leave_quiz_room(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
  v_was_host boolean;
  v_new_host text;
  v_remaining int;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then return; end if;  -- already gone, nothing to do
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

  if v_room.status not in ('waiting', 'active') then
    return;  -- 'finished' or 'abandoned' — nothing to do
  end if;

  v_was_host := (v_player.player_id = v_room.host_id);

  if v_room.status = 'waiting' then
    -- No scores exist yet in a lobby — nothing to forfeit. Delete the row
    -- outright (as quiz_pvp_host_leave.sql always did) so the leaver stops
    -- counting toward the lobby list, the max_players cap, and
    -- start_quiz_room's "need at least 2 players" check
    -- (quiz_group_pvp.sql:291-294). sweep_quiz_room is never called here —
    -- it only ever acts on an 'active' room anyway.
    delete from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id;

    if v_was_host then
      select player_id into v_new_host
        from public.quiz_room_players
        where room_id = p_room_id
        order by joined_at asc
        limit 1;
      if v_new_host is not null then
        update public.quiz_rooms set host_id = v_new_host where id = p_room_id;
        update public.quiz_room_players set is_host = (player_id = v_new_host) where room_id = p_room_id;
      end if;
    end if;

    select count(*) into v_remaining from public.quiz_room_players where room_id = p_room_id;
    if v_remaining = 0 then
      update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
    end if;

  else -- 'active'
    -- Leaving = immediate forfeit, applied through the same single path
    -- every other forfeit goes through — zeroed answers, finished_at and
    -- room status all come from sweep_quiz_room, never duplicated here.
    -- The player row itself is never deleted once the game has started.
    update public.quiz_room_players
      set forfeited = true
      where room_id = p_room_id and player_id = v_player.player_id;

    perform public.sweep_quiz_room(p_room_id);

    -- The host is no longer special re: abandoning an active room — it is
    -- never abandoned here, only handed off to the remaining non-forfeited
    -- player with the earliest joined_at, if any such player exists.
    if v_was_host then
      select player_id into v_new_host
        from public.quiz_room_players
        where room_id = p_room_id and player_id <> v_player.player_id and forfeited = false
        order by joined_at asc
        limit 1;
      if v_new_host is not null then
        update public.quiz_rooms set host_id = v_new_host where id = p_room_id;
        update public.quiz_room_players set is_host = (player_id = v_new_host) where room_id = p_room_id;
      end if;
    end if;
  end if;
end;
$$;

grant execute on function public.leave_quiz_room(uuid, text, text) to anon, authenticated;
