-- ============================================================
-- GUESS-WHO PvP — per-room answer-time control (room creation screen,
-- "ადამიანის წინააღმდეგ" -> "აირჩიე დონე" panel). Host picks ON (30/40/60
-- seconds) or OFF; applies to everyone in that room. Regular quiz PvP is
-- untouched -- this column/RPC is only ever read/written for
-- game_type='guess' rooms, by quiz.js's own choice, not enforced here.
--
-- Deliberately does NOT touch create_quiz_room, get_ai_quiz_questions,
-- join_quiz_room, rejoin_quiz_room or start_quiz_room -- all five stay
-- byte-for-byte as currently live. quiz_rooms already has a public,
-- unrestricted SELECT policy (quiz_rooms_select_all, quiz_pvp.sql), so a
-- guest reads this new column with a plain client-side select (quiz.js's
-- fetchPvpAnswerTime) -- no RPC, no new grant needed for reads. The only
-- new surface is this one function, which the host calls once, right
-- after create_quiz_room succeeds and before the room code is ever shown
-- to them -- so a guest can never join before it's committed.
-- ============================================================

-- 1) Column: null = off (no per-question limit -- quiz.js shows its own
-- "აქ ხარ?" presence check instead, see quiz.js's startGuessWhoAfkWatch).
-- Constrained to the three offered options so a stray client value can
-- never desync quiz.js's own 30/40/60 assumptions.
alter table public.quiz_rooms add column if not exists answer_time_seconds integer;

alter table public.quiz_rooms drop constraint if exists quiz_rooms_answer_time_seconds_check;
alter table public.quiz_rooms add constraint quiz_rooms_answer_time_seconds_check
  check (answer_time_seconds is null or answer_time_seconds in (30, 40, 60));

-- 2) RPC — set_quiz_room_answer_time (NEW, host-only). Mirrors
-- start_quiz_room's own auth pattern exactly (quiz_group_pvp.sql): resolve
-- the caller via quiz_resolve_player, lock the room row, require
-- status='waiting' and host_id match. Called once per room, before any
-- guest can possibly have joined (the client only shows the room code
-- after this resolves) -- no realtime/race handling needed for that
-- reason alone.
create or replace function public.set_quiz_room_answer_time(
  p_room_id uuid, p_seconds integer, p_guest_id text default null, p_guest_name text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  if p_seconds is not null and p_seconds not in (30, 40, 60) then
    raise exception 'invalid answer time';
  end if;

  select * into v_player from public.quiz_resolve_player(p_guest_id, p_guest_name);
  select * into v_room from public.quiz_rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;
  if v_room.status <> 'waiting' then raise exception 'room already started or finished'; end if;
  if v_room.host_id <> v_player.player_id then raise exception 'only the host can change the answer time'; end if;

  update public.quiz_rooms set answer_time_seconds = p_seconds where id = p_room_id;
end;
$$;

grant execute on function public.set_quiz_room_answer_time(uuid, integer, text, text) to anon, authenticated;
