-- ============================================================
--  news like/dislike reactions — Phase D (news engagement, Section 3)
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor and
--  confirm it's done before news/post.html's like/dislike buttons
--  (already written and committed) are considered "done" -- they
--  will error against Supabase until this file is applied.
--
--  Scope: one new table. Nothing here touches any existing table,
--  grant, RLS policy, or settlement/balance/ticket/cron logic.
--
--  Same login-required decision as comments (news_comments.sql),
--  confirmed by Giorgi. One reaction per user per article -- the
--  unique(news_id,user_id) constraint is what makes "switch
--  like<->dislike" an UPDATE and "un-react" a DELETE instead of ever
--  allowing a second row.
--
--  Admin pattern: identical to news_table.sql / news_comments.sql.
-- ============================================================

create table if not exists public.news_reactions (
  id          uuid primary key default gen_random_uuid(),
  news_id     uuid not null references public.news(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  reaction    text not null check (reaction in ('like', 'dislike')),
  created_at  timestamptz not null default now(),
  unique (news_id, user_id)
);

create index if not exists news_reactions_news_id_idx
  on public.news_reactions (news_id);

alter table public.news_reactions enable row level security;
revoke all on public.news_reactions from public;

-- ---------- SELECT ----------
-- Public (anon + authenticated): counts must be visible to everyone,
-- including logged-out visitors, per Giorgi's spec. No published-
-- article gate here (unlike comments) -- a reaction row pointing at
-- an unpublished draft would only matter if the draft's own RLS let
-- someone reach it in the first place, which news_select_published
-- already prevents.
create policy news_reactions_select_all
  on public.news_reactions
  for select
  to anon, authenticated
  using (true);

-- ---------- INSERT ----------
create policy news_reactions_insert_own
  on public.news_reactions
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- ---------- UPDATE (switching like <-> dislike) ----------
create policy news_reactions_update_own
  on public.news_reactions
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------- DELETE (retracting a reaction) ----------
create policy news_reactions_delete_own
  on public.news_reactions
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------- GRANTs ----------
grant select on public.news_reactions to anon, authenticated;
grant insert, update, delete on public.news_reactions to authenticated;
grant all on public.news_reactions to service_role;
