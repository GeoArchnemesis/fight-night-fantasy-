-- ============================================================
--  news table — Phase D1 (news/articles system)
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor and
--  confirm it's done before any code that depends on it is written
--  (D2's admin editor, D3's public /news/ pages).
--
--  Scope: this table only. Nothing here touches any existing table,
--  grant, RLS policy, or settlement/balance/ticket/cron logic.
--
--  Admin pattern used: this project's one real, existing admin
--  mechanism is the `users.is_admin` boolean column, checked against
--  auth.uid() — see admin/admin.html (reads it after login) and its
--  SECURITY DEFINER RPCs like admin_settle_event (checks it inside
--  the function body). There is no separate named Postgres role
--  called "admin" anywhere in this project. The policies below use
--  that same column directly, inlined per policy rather than wrapped
--  in a new helper function — I can't confirm from this repo alone
--  whether a reusable is_admin()-style SQL function already exists
--  server-side (it wouldn't show up in any grep of this repo if it's
--  never called from client-facing JS/HTML). If one already exists,
--  swap these inline EXISTS checks to call it instead, for
--  consistency — just don't want to risk inventing a second,
--  possibly-colliding helper.
--
--  Write-access pattern deliberately differs from this project's
--  settlement-critical tables (which route all writes through
--  SECURITY DEFINER RPCs, with anon/authenticated getting SELECT-only
--  grants — see CLAUDE.md's soccer_matches/NBA-grant-bug notes). This
--  table has no money or concurrency concerns, so `authenticated` is
--  granted direct INSERT/UPDATE/DELETE and RLS's is_admin check is
--  the actual gate — a standard, safe pattern for a plain content
--  table, just a different one. Flagging the deviation rather than
--  silently copying a pattern that doesn't fit.
-- ============================================================

create table if not exists public.news (
  id                   uuid primary key default gen_random_uuid(),

  -- Georgian is the site's primary language — required.
  title_ka             text not null,
  body_ka              text not null,  -- HTML, written by the admin editor (D2)

  -- English is secondary/optional — not every article needs a translation.
  title_en             text,
  body_en              text,           -- HTML

  -- Public URL identifier: /news/<slug>/. Unique constraint below also
  -- creates the index — no separate index needed for the uniqueness
  -- itself. Format check matches this site's existing URL conventions
  -- (lowercase, hyphen-separated, e.g. the football league slugs).
  slug                 text not null unique
                         constraint news_slug_format
                         check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  cover_image_url      text,
  cover_image_alt_ka   text,
  cover_image_alt_en   text,

  meta_title_ka        text,
  meta_title_en        text,
  meta_description_ka  text,
  meta_description_en  text,

  published_at         timestamptz,    -- set explicitly by the admin editor (D2)
                                        -- when publishing; no trigger magic here
  is_published         boolean not null default false,

  author               text,           -- free-text display name, not an FK
                                        -- (single-operator site today; add an
                                        -- FK to auth.users later if that changes)

  category             text,           -- intentionally empty/nullable — Phase F

  -- Not in the original field list, added as standard low-risk
  -- infrastructure (every Supabase table template includes this).
  -- Remove if you don't want it.
  created_at           timestamptz not null default now()
);

-- Extra lookup index for the public listing page (D3), which will
-- query "published articles, newest first".
create index if not exists news_published_at_idx
  on public.news (published_at desc)
  where is_published = true;

alter table public.news enable row level security;

-- Defensive baseline — no implicit access for anyone until granted below.
revoke all on public.news from public;

-- ---------- SELECT ----------

-- Public (anon + authenticated, i.e. everyone) can read published articles.
create policy news_select_published
  on public.news
  for select
  to anon, authenticated
  using (is_published = true);

-- Admins can also read unpublished drafts (needed for the D2 editor
-- to list/edit drafts before they go live).
create policy news_select_admin
  on public.news
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

-- ---------- WRITE (admin only) ----------

create policy news_insert_admin
  on public.news
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

create policy news_update_admin
  on public.news
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

create policy news_delete_admin
  on public.news
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

-- ---------- GRANTs ----------
-- RLS policies above restrict rows; these grants are the base table
-- privilege each role needs before RLS even gets evaluated.

grant select on public.news to anon, authenticated;
grant insert, update, delete on public.news to authenticated;
grant all on public.news to service_role;
