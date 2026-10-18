-- ============================================================
--  news comments — Phase D (news engagement, Section 2)
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor and
--  confirm it's done before news/post.html's comment UI (already
--  written and committed) is considered "done" -- it will error
--  against Supabase until this file is applied.
--
--  Scope: one new table + one new view. Nothing here touches any
--  existing table, grant, RLS policy, or settlement/balance/ticket/
--  cron logic.
--
--  Decision (flagged to Giorgi, can be overridden): comments require
--  being logged in via the site's existing account system (same
--  sb.auth used by /ufc/'s app.js) -- confirmed by Giorgi before this
--  file was written.
--
--  Admin pattern: identical to news_table.sql -- `users.is_admin`
--  checked against auth.uid(), inlined per policy, no new helper.
--
--  Non-threaded, soft-delete only (is_deleted flag) -- no parent_id,
--  no body edits after posting (delete-and-repost instead). Body
--  immutability is enforced at the GRANT level below, not just in
--  client code: `authenticated` only gets UPDATE on the is_deleted
--  column, nothing else on this table can be changed post-insert by
--  anyone except service_role.
-- ============================================================

create table if not exists public.news_comments (
  id          uuid primary key default gen_random_uuid(),
  news_id     uuid not null references public.news(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now(),
  is_deleted  boolean not null default false
);

create index if not exists news_comments_news_id_idx
  on public.news_comments (news_id, created_at);

alter table public.news_comments enable row level security;
revoke all on public.news_comments from public;

-- ---------- SELECT ----------

-- Public (anon + authenticated): non-deleted comments on published
-- articles only. The EXISTS check mirrors news_select_published
-- (news_table.sql) -- same condition that table's own RLS already
-- enforces for this role, not a bypass of it.
create policy news_comments_select_public
  on public.news_comments
  for select
  to anon, authenticated
  using (
    is_deleted = false
    and exists (
      select 1 from public.news
      where news.id = news_comments.news_id and news.is_published = true
    )
  );

-- Admins can also see soft-deleted rows (moderation context) and
-- comments on drafts, with no other restriction.
create policy news_comments_select_admin
  on public.news_comments
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

-- ---------- INSERT ----------

-- Logged-in users only, and only as themselves -- nobody can post a
-- comment that claims to be from a different user_id.
create policy news_comments_insert_own
  on public.news_comments
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- ---------- UPDATE (soft-delete only -- see GRANT below) ----------

-- A user can soft-delete their own comment.
create policy news_comments_update_own
  on public.news_comments
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- An admin can soft-delete anyone's comment.
create policy news_comments_update_admin
  on public.news_comments
  for update
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  )
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

-- No DELETE policy at all -- rows are never hard-deleted by anyone
-- but service_role (admin tooling later, if ever needed).

-- ---------- GRANTs ----------

grant select on public.news_comments to anon, authenticated;
grant insert on public.news_comments to authenticated;
-- Column-scoped: this is what actually stops anyone (including the
-- comment's own author) from editing body/news_id/user_id after
-- posting -- the two UPDATE policies above only gate WHICH ROWS,
-- not WHICH COLUMNS; this GRANT is what limits it to is_deleted.
grant update (is_deleted) on public.news_comments to authenticated;
grant all on public.news_comments to service_role;

-- ============================================================
--  news_commenter_names — public.users is locked down to "own row
--  only" in this project (every sb.from('users') call in app.js /
--  f1-app.js / nba-app.js / football-app.js / admin/*.html filters
--  .eq('id', <the querying user's own id>) -- there is no existing
--  path for one user to read another user's nick directly from
--  `users`). This project's established answer to "show another
--  user's name publicly" is a dedicated view that exposes only the
--  safe columns -- see leaderboard_view / f1_leaderboard_view /
--  nba_leaderboard_view, already used this same way by app.js's
--  leaderboard. This is that same pattern, scoped to just id+nick,
--  for rendering comment authors. Nothing else from `users` (email,
--  phone, balance, etc.) is exposed through it.
-- ============================================================

create or replace view public.news_commenter_names as
  select id, nick from public.users;

grant select on public.news_commenter_names to anon, authenticated;
