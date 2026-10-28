-- ============================================================
--  quiz_pvp_host_leave.sql — LittleMoreUpdates.pdf p9
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor, AFTER
--  quiz_group_pvp.sql and quiz_pvp_r2.sql (replaces leave_quiz_room
--  again, same signature — CREATE OR REPLACE, no DROP needed).
--
--  What was already working (quiz_group_pvp.sql, unchanged by this
--  file): if the host leaves during the 'waiting' lobby, the room is
--  already set to 'abandoned', ufc/quiz.js is already subscribed to
--  quiz_rooms UPDATE via Realtime, and onPvpRoomAbandoned() already
--  alerts + redirects every remaining player to screen-mode. This is
--  exactly the lobby screenshot in the PDF (p9) and exactly the
--  behavior asked for — no frontend change needed for that case.
--
--  The actual gap: once the room is 'active' (the quiz has started),
--  leave_quiz_room only abandons the room if EVERY player has left
--  (v_remaining = 0) — the host leaving mid-game was never a distinct
--  case, so a host quitting an in-progress room left it active with no
--  host, never cancelled. "If the host leaves the room, the room must
--  be cancelled" has no waiting/active qualifier in the ask — fixed to
--  cover both.
--
--  One-line change in the existing 'active' branch: abandon if either
--  the room is now empty OR the player who just left was the host.
--  The existing "did everyone finish" recheck (for a non-host leaving
--  mid-game, 2+ players still remaining) is untouched. The quiz_pvp_r2
--  "last player standing wins" case (removing a player leaves exactly
--  one other player, status -> 'finished') is also untouched — it only
--  applies when the LEAVER isn't the host; if the host is the one
--  remaining single player after someone else leaves, that's still the
--  normal win case, not a cancellation.
--
--  Scope: this one function only. Nothing here touches any other
--  table, grant, RLS policy, or settlement/balance/ticket/cron logic.
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
  v_was_host boolean;
begin
  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then return; end if;  -- already gone, nothing to do
  if not exists (select 1 from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id) then
    raise exception 'not a participant';
  end if;

  v_was_host := (v_player.player_id = v_room.host_id);

  delete from public.quiz_room_players where room_id = p_room_id and player_id = v_player.player_id;

  select count(*) into v_remaining from public.quiz_room_players where room_id = p_room_id;

  if v_room.status = 'waiting' then
    if v_was_host or v_remaining = 0 then
      update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
    end if;
  elsif v_room.status = 'active' then
    if v_remaining = 0 or v_was_host then
      update public.quiz_rooms set status = 'abandoned' where id = p_room_id;
    elsif v_remaining = 1 then
      -- quiz_pvp_r2.sql: down to exactly one remaining player (and that
      -- leave wasn't the host, handled above) declares them the winner
      -- immediately rather than leaving the room active forever.
      update public.quiz_rooms set status = 'finished' where id = p_room_id and status <> 'finished';
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
