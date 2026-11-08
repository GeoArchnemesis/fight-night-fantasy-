-- ============================================================================
-- fights.starts_at — per-fight betting cutoff
-- ============================================================================
-- PROBLEM:
--   place_bet closes betting with a single event-level cutoff:
--     v_cutoff := v_event.event_date + interval '59 minutes';
--   That offset was meant to compensate for an assumed "ESPN reports the
--   event one hour early" bug in app.js (ESPN_FIX_MS). That assumption was
--   checked against ESPN for four events (33, 32, UFC 333, 30) and is wrong:
--   events.event_date is exactly the start of the card's FIRST bout, not an
--   hour early. So today betting stays open for 59 minutes AFTER the opening
--   bout has already started, and every later bout on the card (prelims vs.
--   main card can be ~3 hours apart) shares that same, wrong, single cutoff.
--
-- FIX:
--   a) fights.starts_at — a nullable timestamptz holding that specific bout's
--      own ESPN segment start time (ESPN gives every competition its own
--      `date`, e.g. prelims 22:00Z / main card 01:00Z on the same card).
--      scripts/auto.js (separate change, not part of this file) populates
--      and refreshes it from ESPN.
--   b) place_bet: the event-level `event_date + 59 minutes` cutoff is
--      removed. The per-leg loop — which already rejects a fight that is not
--      'upcoming' or is voided — now additionally rejects the leg once
--        now() >= coalesce(v_fight.starts_at, v_event.event_date) - interval '3 minutes'
--      with its own error code ('fight started', distinct from the existing
--      'fight is not open for betting') so the UI can tell the two cases
--      apart. v_event.event_date is kept as the fallback for any fight whose
--      starts_at hasn't been backfilled/synced yet, so nothing opens betting
--      indefinitely. The top-level event check still rejects with
--      'betting closed' when v_event.status = 'completed'.
--   Everything else in place_bet — the duplicate-ticket guard, the balance
--   lock, the odds snapshot/computation, the ticket and ticket_selections
--   inserts, the success/duplicate return shapes — is byte-for-byte the same
--   as the live function (pulled via pg_get_functiondef() through the
--   Supabase MCP right before writing this file; supabase/place_bet_
--   duplicate_guard.sql was NOT assumed to be current).
--
-- RUN ORDER (both statements are idempotent / safe to re-run):
--   1. The ALTER TABLE below — adds the column (no-op if it already exists).
--   2. The CREATE OR REPLACE FUNCTION below — swaps place_bet's logic.
--   Until scripts/auto.js's starts_at change is deployed and has run at
--   least once per fight, every fight's starts_at is null and the
--   coalesce(...) fallback makes behavior for those fights identical to
--   today (event-level timing) MINUS the 59-minute grace window — i.e. the
--   cutoff becomes "3 minutes before event_date" instead of "59 minutes
--   after event_date" the moment this is applied. Run the commented-out
--   backfill at the bottom first (or deploy the auto.js change and let the
--   next sync pass fill it) if you want every existing upcoming fight to
--   carry an explicit starts_at before relying on the fallback.
--
-- Safe to paste straight into the Supabase SQL editor. NOT applied yet —
-- reviewed and run by hand once approved.
-- ============================================================================

alter table public.fights add column if not exists starts_at timestamptz;

-- ----------------------------------------------------------------------------
-- LIVE public.place_bet definition, fetched via pg_get_functiondef() through
-- the Supabase MCP (read-only) right before writing this file, so you can
-- diff it against the new version below.
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION public.place_bet(p_event_id bigint, p_type text, p_stake numeric, p_total_odds numeric, p_selections jsonb)
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   v_uid uuid := auth.uid();
--   v_event record; v_cutoff timestamptz; v_balance numeric;
--   v_sel jsonb; v_fight record; v_fighter text; v_round int; v_method text;
--   v_base numeric; v_odds numeric; v_factor numeric; v_total numeric := 1;
--   v_computed jsonb := '[]'::jsonb; v_ticket_id bigint;
--   v_dup_ticket record;
-- begin
--   perform public.allow_sensitive_update();   -- balance-guard-ის ნებართვა
--   if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not authenticated'); end if;
--   if p_stake is null or p_stake < 1 or p_stake <> round(p_stake) then
--     return jsonb_build_object('ok', false, 'error', 'invalid stake'); end if;
--   if p_type not in ('express', 'single') then
--     return jsonb_build_object('ok', false, 'error', 'invalid type'); end if;
--   if p_selections is null or jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) = 0 then
--     return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--   if p_type = 'single' and jsonb_array_length(p_selections) <> 1 then
--     return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--
--   select * into v_event from events where id = p_event_id;
--   if not found then return jsonb_build_object('ok', false, 'error', 'event not found'); end if;
--   v_cutoff := v_event.event_date + interval '59 minutes';
--   if now() >= v_cutoff or v_event.status = 'completed' then
--     return jsonb_build_object('ok', false, 'error', 'betting closed'); end if;
--
--   -- === ADDED: duplicate-ticket guard ===
--   -- Same user, same event, same type, same stake, not void, placed in the
--   -- last 60s, with the exact same selection set (order-independent,
--   -- NULL = NULL) => treat as a retried submit and return the existing
--   -- ticket instead of creating a new one / touching the balance.
--   for v_dup_ticket in
--     select t.id, t.total_odds
--     from tickets t
--     where t.user_id = v_uid
--       and t.event_id = p_event_id
--       and t.type = p_type
--       and t.stake = p_stake
--       and t.status not in ('void')
--       and t.placed_at >= now() - interval '60 seconds'
--     order by t.placed_at desc
--   loop
--     if (
--       select count(*) from ticket_selections where ticket_id = v_dup_ticket.id
--     ) = jsonb_array_length(p_selections)
--     and not exists (
--       select fight_id, picked_fighter, picked_round, picked_method
--       from ticket_selections where ticket_id = v_dup_ticket.id
--       except
--       select (e->>'fight_id')::bigint, e->>'picked_fighter',
--         nullif(e->>'picked_round','')::int, nullif(e->>'picked_method','')
--       from jsonb_array_elements(p_selections) e
--     )
--     and not exists (
--       select (e->>'fight_id')::bigint, e->>'picked_fighter',
--         nullif(e->>'picked_round','')::int, nullif(e->>'picked_method','')
--       from jsonb_array_elements(p_selections) e
--       except
--       select fight_id, picked_fighter, picked_round, picked_method
--       from ticket_selections where ticket_id = v_dup_ticket.id
--     )
--     then
--       return jsonb_build_object('ok', true, 'duplicate', true, 'ticket_id', v_dup_ticket.id,
--         'balance', (select balance from users where id = v_uid), 'total_odds', v_dup_ticket.total_odds);
--     end if;
--   end loop;
--   -- === END ADDED ===
--
--   select balance into v_balance from users where id = v_uid for update;
--   if v_balance is null or v_balance < p_stake then
--     return jsonb_build_object('ok', false, 'error', 'insufficient balance'); end if;
--
--   for v_sel in select * from jsonb_array_elements(p_selections) loop
--     select f.id, f.event_id, f.status, f.is_voided, f.max_rounds, f.red_odds, f.blue_odds
--       into v_fight from fights f
--      where f.id = (v_sel->>'fight_id')::bigint and f.event_id = p_event_id;
--     if not found then return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--     if coalesce(v_fight.status,'upcoming') <> 'upcoming' or coalesce(v_fight.is_voided,false) then
--       return jsonb_build_object('ok', false, 'error', 'fight is not open for betting'); end if;
--     if v_fight.red_odds is null or v_fight.blue_odds is null or v_fight.red_odds <= 0 or v_fight.blue_odds <= 0 then
--       return jsonb_build_object('ok', false, 'error', 'odds not available'); end if;
--
--     v_fighter := v_sel->>'picked_fighter';
--     if v_fighter not in ('red','blue') then
--       return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--     v_round := nullif(v_sel->>'picked_round','')::int;
--     v_method := nullif(v_sel->>'picked_method','');
--     v_base := (v_fight.red_odds + v_fight.blue_odds) / 2;
--
--     if v_round is null and v_method is null then
--       v_odds := case when v_fighter='red' then v_fight.red_odds else v_fight.blue_odds end;
--     else
--       v_odds := 1;
--       if v_round is not null then
--         if v_round < 1 or v_round > coalesce(v_fight.max_rounds,3) then
--           return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--         v_odds := v_odds * round(v_base * (1 + v_round*0.15) * 100)/100;
--       end if;
--       if v_method is not null then
--         v_factor := case v_method when 'გადაწყვეტილება' then 0.9 when 'ნოკაუტი' then 1.4 when 'მტკივნეული' then 1.6 else null end;
--         if v_factor is null then return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--         if v_method='გადაწყვეტილება' and v_round is not null then
--           return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
--         v_odds := v_odds * round(v_base * v_factor * 100)/100;
--       end if;
--     end if;
--     v_odds := round(v_odds*100)/100; v_total := v_total * v_odds;
--     v_computed := v_computed || jsonb_build_object('fight_id',v_fight.id,'picked_fighter',v_fighter,
--       'picked_round',v_round,'picked_method',v_method,'odds',v_odds);
--   end loop;
--
--   v_total := round(v_total*100)/100;
--   update users set balance = balance - p_stake where id = v_uid;
--   insert into tickets (user_id,event_id,type,stake,total_odds,potential_win,status,placed_at)
--   values (v_uid,p_event_id,p_type,p_stake,v_total,round(p_stake*v_total),'pending',now())
--   returning id into v_ticket_id;
--   insert into ticket_selections (ticket_id,fight_id,picked_fighter,picked_round,picked_method,odds)
--   select v_ticket_id,(s->>'fight_id')::bigint,s->>'picked_fighter',
--     nullif(s->>'picked_round','')::int,nullif(s->>'picked_method',''),(s->>'odds')::numeric
--   from jsonb_array_elements(v_computed) s;
--
--   return jsonb_build_object('ok',true,'ticket_id',v_ticket_id,
--     'balance',(select balance from users where id=v_uid),'total_odds',v_total);
-- end $function$
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.place_bet(p_event_id bigint, p_type text, p_stake numeric, p_total_odds numeric, p_selections jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_event record; v_balance numeric;
  v_sel jsonb; v_fight record; v_fighter text; v_round int; v_method text;
  v_base numeric; v_odds numeric; v_factor numeric; v_total numeric := 1;
  v_computed jsonb := '[]'::jsonb; v_ticket_id bigint;
  v_dup_ticket record;
begin
  perform public.allow_sensitive_update();   -- balance-guard-ის ნებართვა
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not authenticated'); end if;
  if p_stake is null or p_stake < 1 or p_stake <> round(p_stake) then
    return jsonb_build_object('ok', false, 'error', 'invalid stake'); end if;
  if p_type not in ('express', 'single') then
    return jsonb_build_object('ok', false, 'error', 'invalid type'); end if;
  if p_selections is null or jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) = 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
  if p_type = 'single' and jsonb_array_length(p_selections) <> 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;

  select * into v_event from events where id = p_event_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'event not found'); end if;
  if v_event.status = 'completed' then
    return jsonb_build_object('ok', false, 'error', 'betting closed'); end if;

  -- === ADDED: duplicate-ticket guard ===
  -- Same user, same event, same type, same stake, not void, placed in the
  -- last 60s, with the exact same selection set (order-independent,
  -- NULL = NULL) => treat as a retried submit and return the existing
  -- ticket instead of creating a new one / touching the balance.
  for v_dup_ticket in
    select t.id, t.total_odds
    from tickets t
    where t.user_id = v_uid
      and t.event_id = p_event_id
      and t.type = p_type
      and t.stake = p_stake
      and t.status not in ('void')
      and t.placed_at >= now() - interval '60 seconds'
    order by t.placed_at desc
  loop
    if (
      select count(*) from ticket_selections where ticket_id = v_dup_ticket.id
    ) = jsonb_array_length(p_selections)
    and not exists (
      select fight_id, picked_fighter, picked_round, picked_method
      from ticket_selections where ticket_id = v_dup_ticket.id
      except
      select (e->>'fight_id')::bigint, e->>'picked_fighter',
        nullif(e->>'picked_round','')::int, nullif(e->>'picked_method','')
      from jsonb_array_elements(p_selections) e
    )
    and not exists (
      select (e->>'fight_id')::bigint, e->>'picked_fighter',
        nullif(e->>'picked_round','')::int, nullif(e->>'picked_method','')
      from jsonb_array_elements(p_selections) e
      except
      select fight_id, picked_fighter, picked_round, picked_method
      from ticket_selections where ticket_id = v_dup_ticket.id
    )
    then
      return jsonb_build_object('ok', true, 'duplicate', true, 'ticket_id', v_dup_ticket.id,
        'balance', (select balance from users where id = v_uid), 'total_odds', v_dup_ticket.total_odds);
    end if;
  end loop;
  -- === END ADDED ===

  select balance into v_balance from users where id = v_uid for update;
  if v_balance is null or v_balance < p_stake then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance'); end if;

  for v_sel in select * from jsonb_array_elements(p_selections) loop
    select f.id, f.event_id, f.status, f.is_voided, f.max_rounds, f.red_odds, f.blue_odds, f.starts_at
      into v_fight from fights f
     where f.id = (v_sel->>'fight_id')::bigint and f.event_id = p_event_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
    if coalesce(v_fight.status,'upcoming') <> 'upcoming' or coalesce(v_fight.is_voided,false) then
      return jsonb_build_object('ok', false, 'error', 'fight is not open for betting'); end if;
    -- === ADDED: per-fight cutoff (replaces the old event-level +59min cutoff) ===
    if now() >= coalesce(v_fight.starts_at, v_event.event_date) - interval '3 minutes' then
      return jsonb_build_object('ok', false, 'error', 'fight started'); end if;
    -- === END ADDED ===
    if v_fight.red_odds is null or v_fight.blue_odds is null or v_fight.red_odds <= 0 or v_fight.blue_odds <= 0 then
      return jsonb_build_object('ok', false, 'error', 'odds not available'); end if;

    v_fighter := v_sel->>'picked_fighter';
    if v_fighter not in ('red','blue') then
      return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
    v_round := nullif(v_sel->>'picked_round','')::int;
    v_method := nullif(v_sel->>'picked_method','');
    v_base := (v_fight.red_odds + v_fight.blue_odds) / 2;

    if v_round is null and v_method is null then
      v_odds := case when v_fighter='red' then v_fight.red_odds else v_fight.blue_odds end;
    else
      v_odds := 1;
      if v_round is not null then
        if v_round < 1 or v_round > coalesce(v_fight.max_rounds,3) then
          return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
        v_odds := v_odds * round(v_base * (1 + v_round*0.15) * 100)/100;
      end if;
      if v_method is not null then
        v_factor := case v_method when 'გადაწყვეტილება' then 0.9 when 'ნოკაუტი' then 1.4 when 'მტკივნეული' then 1.6 else null end;
        if v_factor is null then return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
        if v_method='გადაწყვეტილება' and v_round is not null then
          return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
        v_odds := v_odds * round(v_base * v_factor * 100)/100;
      end if;
    end if;
    v_odds := round(v_odds*100)/100; v_total := v_total * v_odds;
    v_computed := v_computed || jsonb_build_object('fight_id',v_fight.id,'picked_fighter',v_fighter,
      'picked_round',v_round,'picked_method',v_method,'odds',v_odds);
  end loop;

  v_total := round(v_total*100)/100;
  update users set balance = balance - p_stake where id = v_uid;
  insert into tickets (user_id,event_id,type,stake,total_odds,potential_win,status,placed_at)
  values (v_uid,p_event_id,p_type,p_stake,v_total,round(p_stake*v_total),'pending',now())
  returning id into v_ticket_id;
  insert into ticket_selections (ticket_id,fight_id,picked_fighter,picked_round,picked_method,odds)
  select v_ticket_id,(s->>'fight_id')::bigint,s->>'picked_fighter',
    nullif(s->>'picked_round','')::int,nullif(s->>'picked_method',''),(s->>'odds')::numeric
  from jsonb_array_elements(v_computed) s;

  return jsonb_build_object('ok',true,'ticket_id',v_ticket_id,
    'balance',(select balance from users where id=v_uid),'total_odds',v_total);
end $function$;

-- ----------------------------------------------------------------------------
-- OPTIONAL ONE-OFF BACKFILL — commented out on purpose.
-- Sets starts_at = events.event_date for every existing fight that doesn't
-- have one yet, so nothing regresses before scripts/auto.js's next sync pass
-- fills in the real per-segment ESPN times. Safe to run more than once
-- (only touches rows where starts_at is still null).
-- ----------------------------------------------------------------------------
-- update public.fights f
--    set starts_at = e.event_date
--   from public.events e
--  where f.event_id = e.id
--    and f.starts_at is null;
