-- ============================================================
--  users_nick_constraint.sql — close the nickname stored-XSS gap
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl). Nothing in this repo runs this file. Nothing
--  here touches any other column, RLS policy, grant, or settlement/
--  balance/ticket-write/cron logic — this only adds a CHECK constraint
--  to public.users.nick.
--
--  Context: the 3-20 character [a-zA-Z0-9._] nickname rule is currently
--  enforced in three client-side places only (app.js, profile/index.html,
--  ufc/quiz.js) and nowhere in the database. RLS lets a user update their
--  own row, and the anon key is public, so anyone can call the Supabase
--  REST API directly and set their own nick to arbitrary text (including
--  HTML/script markup), bypassing every client-side check. That nick is
--  then rendered on leaderboards and in the nav across every sport page.
--  This file adds the same rule as a database CHECK constraint so the
--  client-side validation can no longer be bypassed this way.
-- ============================================================

-- STEP A — READ-ONLY, run this first. Lists every existing row whose nick
-- does NOT already satisfy the rule. If this returns any rows, resolve
-- them by hand (fix or null out the offending nick) before running STEP B
-- — otherwise STEP B will fail outright with a constraint-violation error
-- rather than silently skipping the bad rows. A failed ALTER TABLE changes
-- nothing (Postgres rolls the whole statement back), so running STEP B
-- without checking STEP A first is safe to attempt, but checking first
-- avoids the failure and tells you exactly which rows need a decision.
select id, nick
from public.users
where nick is not null
  and nick !~ '^[a-zA-Z0-9._]{3,20}$';

-- STEP B — the actual constraint. Validates every existing row immediately
-- (no NOT VALID), so it WILL fail with a constraint-violation error if
-- STEP A returned any rows — resolve those first. nick remaining NULL is
-- unaffected either way: a CHECK constraint never rejects a NULL value.
alter table public.users
  add constraint users_nick_format_chk
  check (nick ~ '^[a-zA-Z0-9._]{3,20}$');
