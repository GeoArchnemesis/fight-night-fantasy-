-- ============================================================
--  quiz_results_fix.sql — re-apply get_quiz_results, which drifted
--  from the repo on the live project
--  APPLIED. This file has been run in full against the live Supabase
--  project (qxfcwsiysnjxhxljqigl) via MCP. Idempotent and safe to
--  re-run — it is a single CREATE OR REPLACE plus its grant, no DROP.
--  Applied 2026-11-07.
--
--  THE PROBLEM:
--  The live public.get_quiz_results was confirmed via pg_get_functiondef()
--  to be byte-for-byte the old body from quiz_group_pvp.sql: no
--  `perform public.sweep_quiz_room(p_room_id)` at the top, and no join to
--  public.users, so every player object in the returned `players` jsonb is
--  missing icon/avatar_url/avatar_type. The results podium's avatar lookup
--  therefore always misses and falls back to the default 🥊 glove, and
--  rooms whose last player went missing never got swept before the result
--  was read.
--
--  THE FIX:
--  This file's CREATE OR REPLACE FUNCTION body is copied unchanged from
--  supabase/quiz_presence.sql, lines 247-304 — the version that already
--  added the sweep_quiz_room call and the left join on public.users with
--  icon/avatar_url/avatar_type. Signature and return columns
--  (game_type text, level text, players jsonb, answer_key jsonb) are
--  unchanged.
-- ============================================================

create or replace function public.get_quiz_results(
  p_room_id uuid, p_guest_id text default null, p_guest_name text default null
) returns table(game_type text, level text, players jsonb, answer_key jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_player record;
  v_room public.quiz_rooms%rowtype;
begin
  perform public.sweep_quiz_room(p_room_id);

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
