-- ============================================================
--  news categories (many-to-many) — Phase D (news engagement, Section 1)
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor and
--  confirm it's done before any code that depends on it (admin
--  category management, the article editor's category checkboxes,
--  and the public category chips on /news/ and /news/post.html) is
--  considered "done" — those are already written and committed, but
--  will error against Supabase until this file is applied.
--
--  Scope: these two new tables only. Nothing here touches any
--  existing table, grant, RLS policy, or settlement/balance/ticket/
--  cron logic.
--
--  Note on public.news.category: the existing `news` table (see
--  news_table.sql) already has a nullable `category text` column,
--  marked there as "intentionally empty/nullable — Phase F". This
--  file supersedes that plan with a proper many-to-many system
--  instead (Giorgi wants an article to be able to carry more than
--  one category — MMA + La Liga on the same post, for example).
--  That old column is left in place, untouched and still unused —
--  dropping a column is a separate, deliberate decision Giorgi can
--  make later, not bundled into this file.
--
--  Admin pattern: identical to news_table.sql — `users.is_admin`
--  checked against auth.uid(), inlined per policy, no new helper.
--
--  Write-access pattern: same reasoning as news_table.sql — this is
--  plain content with no money/concurrency concerns, so `authenticated`
--  gets direct INSERT/UPDATE/DELETE and RLS's is_admin check is the
--  actual gate.
-- ============================================================

-- ---------- news_categories ----------

create table if not exists public.news_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique
                constraint news_categories_slug_format
                check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_ka     text not null,
  name_en     text,
  created_at  timestamptz not null default now()
);

alter table public.news_categories enable row level security;
revoke all on public.news_categories from public;

-- Anyone can read the category list (it's reference data, not gated
-- by any publish/draft state of its own).
create policy news_categories_select_all
  on public.news_categories
  for select
  to anon, authenticated
  using (true);

create policy news_categories_insert_admin
  on public.news_categories
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

create policy news_categories_update_admin
  on public.news_categories
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

create policy news_categories_delete_admin
  on public.news_categories
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

grant select on public.news_categories to anon, authenticated;
grant insert, update, delete on public.news_categories to authenticated;
grant all on public.news_categories to service_role;

-- ---------- news_article_categories (join table) ----------
-- on delete cascade on BOTH sides: deleting an article drops its
-- category links (obviously), and deleting a category just unlinks
-- it from every article that had it -- no article is ever deleted as
-- a side effect of removing a category, and no join row is ever left
-- orphaned pointing at a category/article that no longer exists.

create table if not exists public.news_article_categories (
  news_id      uuid not null references public.news(id) on delete cascade,
  category_id  uuid not null references public.news_categories(id) on delete cascade,
  primary key (news_id, category_id)
);

alter table public.news_article_categories enable row level security;
revoke all on public.news_article_categories from public;

-- Public read -- needed so the /news/ listing and article page can
-- show category chips without being logged in. This does not leak
-- anything about unpublished drafts beyond the join row itself (no
-- article title/body is exposed here), and public.news's own RLS
-- already keeps unpublished articles out of the public query that
-- would embed this table.
create policy news_article_categories_select_all
  on public.news_article_categories
  for select
  to anon, authenticated
  using (true);

create policy news_article_categories_insert_admin
  on public.news_article_categories
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

create policy news_article_categories_delete_admin
  on public.news_article_categories
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

-- No UPDATE policy: the admin editor syncs an article's categories by
-- delete-then-reinsert (simplest for this scale, and the table has no
-- columns worth updating in place -- it's a pure link).

grant select on public.news_article_categories to anon, authenticated;
grant insert, delete on public.news_article_categories to authenticated;
grant all on public.news_article_categories to service_role;

-- ---------- Seed: the 4 categories Giorgi named ----------
-- He can rename/add more from the admin UI afterward -- this just
-- gets the list off the ground non-empty.

insert into public.news_categories (slug, name_ka, name_en) values
  ('mma',        'MMA',       'MMA'),
  ('football',   'ფეხბურთი',  'Football'),
  ('la-liga',    'ლა ლიგა',   'La Liga'),
  ('ligue-1',    'ლიგა 1',    'Ligue 1')
on conflict (slug) do nothing;
