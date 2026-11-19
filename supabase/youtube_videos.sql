-- ============================================================
--  youtube_videos table — Task 4, phase 1 (YouTube video sync)
-- ============================================================
--  Applied directly via the Supabase connection (not hand-run in the
--  SQL Editor like this project's other supabase/*.sql files) --
--  Giorgi approved this one being applied for him. Still documented
--  the same way as every other file here, for anyone reading it later.
--
--  Scope: this table only. Nothing here touches any existing table,
--  grant, RLS policy, or settlement/balance/ticket/cron logic.
--
--  Populated exclusively by scripts/youtube-sync.js, authenticated as
--  service_role (bypasses RLS entirely), on a 6-hour GitHub Actions
--  cron (.github/workflows/youtube-sync.yml). No admin UI fills any
--  field by hand, with one narrow exception below.
--
--  Admin pattern: identical to news_table.sql / news_comments.sql --
--  `users.is_admin` checked against auth.uid(), inlined per policy,
--  no new helper function.
--
--  One narrow admin write path (Giorgi's call): an admin may flip
--  is_published -- e.g. to instantly hide a video without waiting for
--  YouTube's own privacy change to reach the next sync run -- and
--  ONLY is_published. Enforced the same way news_comments.sql enforces
--  its own is_deleted-only column: the two UPDATE policies below gate
--  WHICH ROWS (admins only), and the column-scoped GRANT further down
--  gates WHICH COLUMN (is_published only) -- Postgres rejects any
--  UPDATE statement that touches a column outside that grant, even
--  from an admin, even in the same statement as an is_published change.
-- ============================================================

create table if not exists public.youtube_videos (
  id                uuid primary key default gen_random_uuid(),

  -- Natural key from the YouTube Data API -- 11 chars, URL-safe
  -- alphabet. Plays the same role slug plays on news: unique +
  -- format-checked, self-indexing (no separate index needed for
  -- the uniqueness itself).
  video_id          text not null unique
                      constraint youtube_videos_video_id_format
                      check (video_id ~ '^[A-Za-z0-9_-]{11}$'),

  title             text not null,
  thumbnail_url     text not null,  -- best available: maxres > standard > high > medium > default

  -- Parsed from the API's ISO 8601 duration (PT#M#S) into plain
  -- seconds -- needed as a number, not a string, for the Shorts
  -- cutoff (<60s, enforced in the sync script -- rows under 60s are
  -- never inserted at all, never land here) and for any future
  -- sort/filter by length.
  duration_seconds  integer not null,

  -- statistics.viewCount -- refreshed on every sync run, so this is
  -- a snapshot as of the last sync, not live.
  view_count        bigint not null default 0,

  published_at      timestamptz not null,  -- the video's real publish time (videos.list snippet.publishedAt)

  -- Mirrors YouTube's privacyStatus === 'public'. The sync script also
  -- flips this to false if a previously-seen video_id disappears from
  -- the channel's public uploads list (made private/unlisted/deleted --
  -- an API-key-only playlistItems.list call only ever sees public
  -- items, so a de-listed video is never re-visited any other way).
  -- The one field an admin may also override by hand -- see the
  -- column-scoped GRANT below.
  is_published      boolean not null default true,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()  -- bumped every sync pass -- "last confirmed synced"
);

-- Lookup index for the public listing (once videos are merged into
-- the News section, phase 3) -- "published videos, newest first",
-- same partial-index shape as news_published_at_idx.
create index if not exists youtube_videos_published_at_idx
  on public.youtube_videos (published_at desc)
  where is_published = true;

alter table public.youtube_videos enable row level security;

-- Defensive baseline — no implicit access for anyone until granted below.
revoke all on public.youtube_videos from public;

-- ---------- SELECT ----------

-- Public (anon + authenticated, i.e. everyone) can read published videos.
create policy youtube_videos_select_published
  on public.youtube_videos
  for select
  to anon, authenticated
  using (is_published = true);

-- Admins can also see hidden/unpublished rows (needed to find and
-- toggle them -- see the narrow write path below).
create policy youtube_videos_select_admin
  on public.youtube_videos
  for select
  to authenticated
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

-- ---------- UPDATE (is_published only — see GRANT below) ----------

create policy youtube_videos_update_admin
  on public.youtube_videos
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

-- No INSERT/DELETE policy at all -- rows are only ever created/removed
-- by service_role (the sync script never deletes; it only unpublishes).

-- ---------- GRANTs ----------
-- RLS policies above restrict rows; these grants are the base table
-- privilege each role needs before RLS even gets evaluated.

grant select on public.youtube_videos to anon, authenticated;
-- Column-scoped: this is what actually stops an admin from editing
-- title/thumbnail_url/duration_seconds/view_count/etc by hand -- the
-- UPDATE policy above only gates WHICH ROWS, not WHICH COLUMNS; this
-- GRANT is what limits it to is_published.
grant update (is_published) on public.youtube_videos to authenticated;
grant all on public.youtube_videos to service_role;
