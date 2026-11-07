-- ============================================================================
-- place_bet: duplicate-ticket guard
-- ============================================================================
-- WHAT CHANGED:
--   One guard block was added, right after the betting-window/event checks
--   and BEFORE the user's balance is selected/locked (`select balance ... for
--   update`). It looks for an existing ticket of the same user, same event,
--   same type, same stake, status not in ('void'), placed in the last 60
--   seconds, whose selections are the exact same set as the incoming
--   p_selections (same count, same (fight_id, picked_fighter, picked_round,
--   picked_method) tuples, order-independent, NULL = NULL). If found, the
--   function inserts nothing, touches no balance, and returns the normal
--   success shape for the EXISTING ticket with an added 'duplicate', true
--   key: jsonb_build_object('ok',true,'duplicate',true,'ticket_id',...,
--   'balance',...,'total_odds',...).
--
--   Nothing else was touched: every other check, the odds computation, the
--   insert into tickets/ticket_selections, and the final success return for
--   a genuinely new ticket are byte-for-byte the same as before. Signature,
--   return type, LANGUAGE, SECURITY DEFINER and SET search_path are all
--   preserved via CREATE OR REPLACE FUNCTION (the function is never dropped).
--
--   Outside the 60-second window the same bet can be placed again normally
--   — that's intentional, this only guards against accidental double-submit
--   (double-click, retried network request, etc).
--
-- Safe to paste straight into the Supabase SQL editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ORIGINAL public.place_bet definition, fetched via pg_get_functiondef()
-- through the Supabase MCP (read-only) right before writing this file, so you
-- can diff it against the new version below.
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
  v_event record; v_cutoff timestamptz; v_balance numeric;
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
  v_cutoff := v_event.event_date + interval '59 minutes';
  if now() >= v_cutoff or v_event.status = 'completed' then
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
    select f.id, f.event_id, f.status, f.is_voided, f.max_rounds, f.red_odds, f.blue_odds
      into v_fight from fights f
     where f.id = (v_sel->>'fight_id')::bigint and f.event_id = p_event_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'invalid selection or odds not available yet'); end if;
    if coalesce(v_fight.status,'upcoming') <> 'upcoming' or coalesce(v_fight.is_voided,false) then
      return jsonb_build_object('ok', false, 'error', 'fight is not open for betting'); end if;
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
