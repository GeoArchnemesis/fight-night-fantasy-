-- ============================================================
--  phone_uniqueness.sql — Phase R5 (part 2b)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once. Safe to re-run.
--
--  Context: Giorgi already added a unique index on users.phone live
--  (users_phone_unique, non-null phones only — confirmed, not created by
--  this file). This file adds the one missing piece: a narrow,
--  anon-callable RPC the frontend can use to check phone availability
--  BEFORE calling auth.signUp() / updating a profile, exactly mirroring
--  the existing is_nick_taken(p_nick, p_exclude_user_id) RPC (that one
--  predates this repo's migration files and isn't defined here either —
--  this file only adds the phone equivalent, same shape, so it's grantable
--  the same way without needing to touch or understand its definition).
--
--  What this does:
--   1. is_phone_taken(p_phone, p_exclude_user_id) — SECURITY DEFINER,
--      returns true if another row already has this exact (already
--      normalized by the caller — see app.js/profile's normalizePhone())
--      phone value. p_exclude_user_id lets a profile-edit check exclude
--      the user's own current row (same pattern is_nick_taken already
--      uses), so re-saving your own unchanged phone never triggers a
--      false "taken" result.
--   2. Granted to anon AND authenticated — registration happens before
--      the caller has a session, same as is_nick_taken.
--   3. normalize_phone_text(p_phone) + a one-time UPDATE — existing stored
--      phone values predate normalizePhone() and may still have spaces/
--      dashes/a '+995'/'995'/'0' prefix (e.g. the live row
--      '+995 568 559 926'). Left as-is, a future signup/edit with
--      '568559926' for the same real number would NOT collide with it
--      under the unique index — two different stored representations of
--      the same number. This section rewrites every stored value to
--      exactly the same digits-only format normalizePhone() produces, so
--      old and new rows compare correctly. The function mirrors
--      normalizePhone()'s logic statement-for-statement (strip non-digits,
--      then strip a leading 995 or 0 only if the result would still be
--      longer than 9 digits) so the two are guaranteed to agree.
--
--  This does NOT create the unique index itself (already live) and does
--  NOT change any RLS policy or grant on users beyond EXECUTE on
--  is_phone_taken.
-- ============================================================

create or replace function public.is_phone_taken(p_phone text, p_exclude_user_id uuid default null)
returns boolean
language sql security definer set search_path = public as $$
  select exists(
    select 1 from public.users
    where phone = p_phone
      and phone is not null
      and (p_exclude_user_id is null or id <> p_exclude_user_id)
  );
$$;

grant execute on function public.is_phone_taken(text, uuid) to anon, authenticated;


-- ============================================================
-- 3) One-time data migration — normalize existing users.phone values
-- ============================================================
-- Mirrors normalizePhone() in app.js/f1-app.js/nba-app.js/football-app.js/
-- profile/index.html exactly: strip to digits, then strip a leading 995 or
-- 0 only if the result would still be longer than 9 digits afterward.
-- IMMUTABLE/no table access, so safe to leave defined permanently (also
-- makes re-running step B below a trivial no-op on already-normalized data).
create or replace function public.normalize_phone_text(p_phone text)
returns text
language sql immutable as $$
  select case
    when p_phone is null then null
    else (
      with d0 as (select regexp_replace(p_phone, '\D', '', 'g') as d),
           d1 as (select case when length(d.d) > 9 and d.d like '995%' then substring(d.d from 4) else d.d end as d from d0 d),
           d2 as (select case when length(d.d) > 9 and d.d like '0%' then substring(d.d from 2) else d.d end as d from d1 d)
      select d from d2
    )
  end;
$$;

-- STEP A — READ-ONLY, run this first. The existing unique index only ever
-- compared RAW stored text, so it cannot have caught two different rows
-- whose values normalize to the SAME digits (e.g. '568559926' and
-- '+995 568 559 926' stored as two separate users before this migration
-- ever ran). If this returns ANY rows, resolve them by hand (decide which
-- account actually owns that number, null out or fix the other) before
-- running STEP B — otherwise STEP B will fail outright. A failed UPDATE
-- changes nothing; Postgres rolls the whole statement back, so this is
-- safe to attempt even if you haven't checked, but checking first avoids
-- the failure and tells you exactly which rows need a decision.
select public.normalize_phone_text(phone) as normalized,
       array_agg(id) as user_ids,
       array_agg(phone) as raw_values,
       count(*) as n
from public.users
where phone is not null
group by public.normalize_phone_text(phone)
having count(*) > 1;

-- STEP B — the actual one-time normalization. Only touches rows whose
-- stored value isn't already in normalized form, so safe to re-run (a
-- second run updates zero rows).
update public.users
set phone = public.normalize_phone_text(phone)
where phone is not null
  and phone <> public.normalize_phone_text(phone);


-- ============================================================
-- OPTIONAL — run separately, read-only, sanity check
-- ============================================================
-- confirm the unique index Giorgi added is exactly what is_phone_taken
-- above assumes (unique on phone, non-null only):
-- select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename = 'users' and indexname = 'users_phone_unique';
--
-- after STEP B, confirm nothing is left un-normalized:
-- select id, phone from public.users where phone is not null and phone <> public.normalize_phone_text(phone);
