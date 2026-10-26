-- ============================================================
--  profile_redesign.sql — Phase Q3 (profile redesign + visiting mode)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom. Safe to re-run —
--  every statement is IF NOT EXISTS / OR REPLACE / additive.
--
--  Per QUIZ-AND-PROFILE-PRD.md §3. Sections, in order:
--   1. users.bio / avatar_url / avatar_type (new, nullable/defaulted columns)
--   2. avatars storage bucket (public read, write restricted to own folder)
--   3. news_article_views (new table, for the "read articles" profile slider)
--   4. get_public_profile(p_nick) — NEW, not explicitly itemized in the PRD's
--      SQL list, but required for §3.0 (visiting mode) — see the note in
--      that section for why this is the safe way to expose it.
--   5. ── HIGHEST RISK, ISOLATED BLOCK ── additive SELECT-only policy on
--      tickets/f1_tickets/nba_tickets/soccer_tickets. Does not touch any
--      existing policy, grant, or write/settlement path. Read the block's
--      own header comment before running.
--
--  Order relative to the other two Phase Q files: independent of both
--  quiz_no_repeat.sql and quiz_group_pvp.sql — can be run before, after,
--  or in any order relative to them.
-- ============================================================


-- ============================================================
-- 1) users — bio / avatar_url / avatar_type
-- ============================================================
-- Confirmed via grep (no code anywhere references these names today) that
-- these are genuinely new columns — no naming collision risk like Q1's
-- quiz_questions.id surprise.
alter table public.users add column if not exists bio text;
alter table public.users
  add column if not exists avatar_type text not null default 'emoji' check (avatar_type in ('photo','emoji'));
alter table public.users add column if not exists avatar_url text;


-- ============================================================
-- 2) STORAGE — avatars bucket (public read, own-folder write)
-- ============================================================
-- Path convention mirrors the existing id-verification bucket's upload
-- code (app.js: `${currentUser.id}/${Date.now()}.${ext}`) — i.e. the first
-- path segment is the uploader's auth.uid(). Unlike id-verification
-- (private, read only via createSignedUrl), avatars must be PUBLIC read
-- (shown on leaderboards, in visiting mode, etc. per PRD §3.1) — that part
-- mirrors the news-images bucket instead (public, getPublicUrl).
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists avatars_own_insert on storage.objects;
create policy avatars_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_own_update on storage.objects;
create policy avatars_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_own_delete on storage.objects;
create policy avatars_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);


-- ============================================================
-- 3) TABLE — news_article_views (§3.4)
-- ============================================================
-- NOTE on a PRD self-contradiction I resolved rather than silently papered
-- over: §3.4's literal schema note says "RLS: a user can only select/
-- insert/update their own rows", but §3.0/§3.4-point-5 both require this
-- same data to be visible in VISITING mode (another user's read-articles
-- slider). Those two statements can't both be true. I kept write access
-- (insert/update) strictly own-row-only, and opened SELECT to any
-- authenticated user — i.e. the exact same "owner writes, anyone signed-in
-- reads" shape already used for the tickets tables below, and already
-- proven safe for news_reactions (its like-count query already reads
-- every user's rows, confirmed in news/post.html). Low sensitivity data
-- (an article-view timestamp) and no write-path is touched, so this is
-- not a judgment call I considered worth pausing the whole phase over —
-- flagging it here for the record instead.
create table if not exists public.news_article_views (
  user_id          uuid not null,
  article_slug     text not null,
  first_viewed_at  timestamptz not null default now(),
  last_viewed_at   timestamptz not null default now(),
  primary key (user_id, article_slug)
);

alter table public.news_article_views enable row level security;

drop policy if exists news_article_views_select_authenticated on public.news_article_views;
create policy news_article_views_select_authenticated on public.news_article_views
  for select to authenticated using (true);

drop policy if exists news_article_views_insert_own on public.news_article_views;
create policy news_article_views_insert_own on public.news_article_views
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists news_article_views_update_own on public.news_article_views;
create policy news_article_views_update_own on public.news_article_views
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.news_article_views to authenticated;


-- ============================================================
-- 4) RPC — get_public_profile (NEW — needed for §3.0, not in the PRD's
--    literal SQL list)
-- ============================================================
-- Visiting mode (profile/?u=<nick>) needs to look up ANOTHER user's public
-- fields by nickname. The existing `users` table almost certainly has an
-- RLS policy today restricting SELECT to auth.uid() = id (own row only) —
-- that's the only way the current profile page's `.eq('id', session.user.id)`
-- read makes sense as a *restriction* worth having at all. Widening that
-- with a blanket SELECT-for-anyone policy would expose phone/telegram/
-- balance/is_admin/registration_ip/etc. to any signed-in user — a much
-- bigger hole than anything the PRD asked for. A SECURITY DEFINER RPC that
-- returns ONLY the columns the PRD actually calls public (§3.0: avatar/
-- emoji, nick, bio) is the narrow, safe equivalent, and needs no change to
-- any existing `users` RLS policy at all.
create or replace function public.get_public_profile(p_nick text)
returns table(id uuid, nick text, icon text, bio text, avatar_url text, avatar_type text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  return query
    select u.id, u.nick, u.icon, u.bio, u.avatar_url, u.avatar_type
    from public.users u
    where u.nick = p_nick
    limit 1;
end;
$$;

grant execute on function public.get_public_profile(text) to authenticated;


-- ============================================================
-- 5) ── HIGHEST RISK, ISOLATED BLOCK ──
--    Additive SELECT-only policy: tickets / f1_tickets / nba_tickets /
--    soccer_tickets, readable by ANY authenticated user (needed for
--    §3.0's public ticket history in visiting mode).
--
--    This does NOT touch, drop, or replace any existing policy on these
--    tables. Postgres combines multiple PERMISSIVE policies for the same
--    command with OR — so whatever "own rows only" SELECT policy already
--    exists today keeps working exactly as before for every other caller;
--    this just adds a second, broader SELECT policy alongside it. (All of
--    this project's policies so far — quiz_rooms, quiz_room_players — are
--    plain CREATE POLICY with no RESTRICTIVE keyword, so this OR-combine
--    behavior is the standard case here, not a special one.)
--
--    Each policy here is named uniquely (table-prefixed) specifically so
--    `drop policy if exists <this policy>` on a re-run can never collide
--    with or remove whatever the existing, differently-named policy is.
--
--    This block ONLY adds `for select` policies — by construction, a
--    `for select` policy cannot grant INSERT/UPDATE/DELETE access under
--    any circumstance, so "read-only" here is structural, not a promise.
--    No existing INSERT/UPDATE policy, and no settlement/ticket-placement
--    RPC (place_bet_*, cashout_ticket_*, settle_*), is referenced or
--    altered anywhere in this file.
--
--    ⚠️ After running this file, re-verify sign-up and placing a ticket
--    (at least one sport) still work end-to-end, and confirm in the
--    dashboard (Authentication/Database -> Policies) that each policy
--    below shows only "SELECT" under command — per the Hard Rules.
-- ============================================================
drop policy if exists tickets_select_any_authenticated on public.tickets;
create policy tickets_select_any_authenticated on public.tickets
  for select to authenticated using (true);

drop policy if exists f1_tickets_select_any_authenticated on public.f1_tickets;
create policy f1_tickets_select_any_authenticated on public.f1_tickets
  for select to authenticated using (true);

drop policy if exists nba_tickets_select_any_authenticated on public.nba_tickets;
create policy nba_tickets_select_any_authenticated on public.nba_tickets
  for select to authenticated using (true);

drop policy if exists soccer_tickets_select_any_authenticated on public.soccer_tickets;
create policy soccer_tickets_select_any_authenticated on public.soccer_tickets
  for select to authenticated using (true);

-- Almost certainly already granted today (the sport pages already read
-- their own tickets successfully) — included anyway so this file is
-- self-contained and safe to run on a database where it somehow isn't.
grant select on public.tickets to authenticated;
grant select on public.f1_tickets to authenticated;
grant select on public.nba_tickets to authenticated;
grant select on public.soccer_tickets to authenticated;


-- ============================================================
-- OPTIONAL — run separately, read-only, sanity checks
-- ============================================================
-- confirm the new ticket SELECT policies are SELECT-only (no cmd other
-- than SELECT should ever appear for these specific policy names):
-- select schemaname, tablename, policyname, cmd, roles
-- from pg_policies
-- where policyname in (
--   'tickets_select_any_authenticated', 'f1_tickets_select_any_authenticated',
--   'nba_tickets_select_any_authenticated', 'soccer_tickets_select_any_authenticated'
-- );
--
-- confirm the avatars bucket + its policies:
-- select id, name, public from storage.buckets where id = 'avatars';
-- select policyname, cmd, roles from pg_policies
-- where tablename = 'objects' and policyname like 'avatars_%';
--
-- confirm news_article_views grants:
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'news_article_views'
-- order by grantee, privilege_type;
