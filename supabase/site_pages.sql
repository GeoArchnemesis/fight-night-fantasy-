-- ============================================================
--  site_pages — admin-editable content for the static text pages
--  (about, terms, privacy)
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor, then run
--  supabase/site_pages_seed.sql (in that order) before any code that
--  depends on it is written (scripts/prerender-pages.js, the admin
--  editor's new tab).
--
--  Scope: this table only. Nothing here touches any existing table,
--  grant, RLS policy, or settlement/balance/ticket/cron logic.
--
--  Admin pattern: same as supabase/news_table.sql — this project's one
--  real admin mechanism is the `users.is_admin` boolean, checked
--  against auth.uid(), inlined per policy rather than a shared helper
--  function (same reasoning as that file: can't confirm from this repo
--  alone whether a reusable is_admin()-style function already exists
--  server-side). No money/concurrency concerns here either, so
--  `authenticated` gets direct INSERT/UPDATE/DELETE grants and RLS's
--  is_admin check is the actual gate — the same deviation from the
--  settlement-critical-table pattern (SECURITY DEFINER RPCs only,
--  anon/authenticated SELECT-only) that news_table.sql already
--  documents; not repeated here.
--
--  anon must be able to SELECT: scripts/prerender-pages.js (modelled
--  on scripts/prerender-news.js) runs in GitHub Actions with the
--  public ANON key, same as the news prerender script — there is no
--  service_role key available to it.
-- ============================================================

create table if not exists public.site_pages (
  slug        text primary key
                constraint site_pages_slug_check
                check (slug in ('about', 'terms', 'privacy')),
  title       text not null,
  body_html   text not null,
  updated_at  timestamptz not null default now()
);

alter table public.site_pages enable row level security;

-- Defensive baseline — no implicit access for anyone until granted below.
revoke all on public.site_pages from public;

-- ---------- updated_at: always refreshed on update, not just on insert ----------

create or replace function public.site_pages_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger site_pages_set_updated_at
  before update on public.site_pages
  for each row
  execute function public.site_pages_set_updated_at();

-- ---------- SELECT ----------

-- Public (anon + authenticated, i.e. everyone, including the
-- unauthenticated prerender script) can read every row — these are the
-- live public pages, there is no draft/published distinction here
-- unlike news.
create policy site_pages_select_public
  on public.site_pages
  for select
  to anon, authenticated
  using (true);

-- ---------- WRITE (admin only) ----------

create policy site_pages_insert_admin
  on public.site_pages
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

create policy site_pages_update_admin
  on public.site_pages
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

create policy site_pages_delete_admin
  on public.site_pages
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

grant select on public.site_pages to anon, authenticated;
grant insert, update, delete on public.site_pages to authenticated;
grant all on public.site_pages to service_role;
