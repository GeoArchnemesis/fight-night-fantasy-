-- ============================================================
--  profile_updates.sql — Phase R4 (MoreUpdatesOct.pdf p10-12)
--  NOT applied automatically. Nothing in this repo runs this file — review
--  it, then paste the WHOLE thing into the Supabase SQL Editor (project
--  qxfcwsiysnjxhxljqigl) and run it once, top to bottom, AFTER
--  profile_redesign.sql (this file extends its get_public_profile RPC).
--  Safe to re-run.
--
--  What this does, in order:
--   1. users.articles_public (NEW) — lets a user hide their "read/liked
--      articles" strip from anyone visiting their public profile
--      (confirmed: default TRUE / public-by-default). Own profile always
--      shows the strip to the owner regardless of this flag — it only
--      gates what OTHER viewers see (profile/index.html checks it in
--      visiting mode before calling loadAndRenderArticles()).
--   2. get_public_profile(p_nick) — DROP + CREATE (not just OR REPLACE,
--      since the return column list is changing) to also return
--      articles_public, so the frontend's visiting-mode branch can read
--      it without a second round trip. Same safe, narrow column set as
--      before (id/nick/icon/bio/avatar_url/avatar_type) plus this one
--      boolean — still no phone/telegram/balance/email exposure.
--   3. GRANT (fix, found live by Giorgi testing the toggle) — adding the
--      column did NOT grant authenticated UPDATE on it (column-level
--      grants on public.users for nick/icon/bio/phone/telegram/
--      avatar_url/avatar_type already exist live in Supabase, from before
--      this repo's migration files — see CLAUDE.md's note that grants
--      aren't version-controlled here — but a brand-new column is never
--      automatically covered by an existing column-list grant). Without
--      this, profile/index.html's toggle update silently fails with
--      "permission denied" and the checkbox snaps back on. This is the
--      only reason to re-run this file if you already ran it once.
--
--  Note on enforcement scope (read before relying on this for anything
--  more sensitive than "did I read this article"): news_article_views
--  already has a broad SELECT-for-any-authenticated-user policy from
--  profile_redesign.sql (§3.4 there). This migration does NOT make that
--  table-level policy conditional on articles_public — it only adds a
--  frontend gate on the one intended access path (the profile page UI).
--  That's consistent with the already-low sensitivity of "article view"
--  rows and keeps this change additive/narrow; if that's ever not good
--  enough, a stricter RLS policy with a users.articles_public lookup
--  would need its own reviewed migration.
-- ============================================================


-- ============================================================
-- 1) users — articles_public (NEW)
-- ============================================================
alter table public.users add column if not exists articles_public boolean not null default true;

-- fix (this is the line Giorgi must re-run the file for): the new column
-- above is not automatically covered by any existing column-level UPDATE
-- grant on public.users — without this, the toggle in profile/index.html
-- fails with "permission denied" and silently reverts.
grant update (articles_public) on public.users to authenticated;


-- ============================================================
-- 2) RPC — get_public_profile (adds articles_public to the return row)
-- ============================================================
drop function if exists public.get_public_profile(text);

create function public.get_public_profile(p_nick text)
returns table(id uuid, nick text, icon text, bio text, avatar_url text, avatar_type text, articles_public boolean)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  return query
    select u.id, u.nick, u.icon, u.bio, u.avatar_url, u.avatar_type, u.articles_public
    from public.users u
    where u.nick = p_nick
    limit 1;
end;
$$;

grant execute on function public.get_public_profile(text) to authenticated;


-- ============================================================
-- OPTIONAL — run separately, read-only, sanity check
-- ============================================================
-- confirm the new column landed with the right default:
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'users' and column_name = 'articles_public';
