-- ============================================================
--  news_feed_view — Task 4, phase 3 (merge news + youtube_videos)
-- ============================================================
--  Applied directly via the Supabase connection (same as youtube_videos.sql
--  was) -- Giorgi approved. Documented the same way as every other file
--  here for anyone reading it later.
--
--  Scope: this view only. Nothing here touches any existing table, grant,
--  RLS policy, or settlement/balance/ticket/cron logic.
--
--  Why a view instead of two separate queries + a client-side merge-sort:
--  scripts/prerender-news.js and news/index.html's own live pagination
--  query both already do exactly one `select ... order by published_at
--  desc` against `news`. Pointing that same one query at this view
--  instead keeps it exactly one query, one round trip, with Postgres
--  doing the union+sort -- no second fetch, no client-side interleaving
--  of two result sets, anywhere this is used.
--
--  security_invoker = true (supported since Postgres 15; this project is
--  on 17.6, confirmed before writing this) means a querying role's own
--  grants/RLS on `news` and `youtube_videos` still apply through the
--  view -- this view does not bypass either table's RLS, it just unions
--  two already-public-readable result sets. The `where is_published =
--  true` on each side is kept anyway, as defense in depth, matching this
--  project's existing style of not relying on RLS alone when a query can
--  just say what it means directly.
--
--  Column shape: the article side carries every public.news column
--  (unchanged names) so scripts/prerender-news.js's existing per-article
--  page/sidebar/sitemap code keeps reading a.title_ka/a.body_ka/etc.
--  exactly as it does today -- zero changes needed there beyond pointing
--  the one query at this view and filtering by kind='article' for the
--  per-article-page/sidebar/sitemap logic (which must never see videos --
--  they have no slug, no body, no page of their own). The video side has
--  no body_ka/body_en/meta_*/cover_image_alt_*/author/category (videos
--  have none of these) and instead carries video_id/duration_seconds/
--  view_count/thumbnail_url, which article rows don't have.
--
--  Language (task E): a video row's title_en is literally the same
--  Georgian title_ka value, never null -- videos are Georgian-only and
--  show the same title in both the KA and EN listings, never translated.
-- ============================================================

create or replace view public.news_feed_view
with (security_invoker = true) as
select
  'article'::text as kind,
  n.id, n.slug,
  n.title_ka, n.body_ka, n.title_en, n.body_en,
  n.cover_image_url, n.cover_image_alt_ka, n.cover_image_alt_en,
  n.meta_title_ka, n.meta_title_en, n.meta_description_ka, n.meta_description_en,
  n.published_at, n.is_published, n.author, n.category, n.created_at,
  null::text as video_id, null::integer as duration_seconds,
  null::bigint as view_count, null::text as thumbnail_url
from public.news n
where n.is_published = true

union all

select
  'video'::text as kind,
  v.id, null::text as slug,
  v.title as title_ka, null::text as body_ka, v.title as title_en, null::text as body_en,
  null::text as cover_image_url, null::text as cover_image_alt_ka, null::text as cover_image_alt_en,
  null::text as meta_title_ka, null::text as meta_title_en, null::text as meta_description_ka, null::text as meta_description_en,
  v.published_at, v.is_published, null::text as author, null::text as category, v.created_at,
  v.video_id, v.duration_seconds,
  v.view_count, v.thumbnail_url
from public.youtube_videos v
where v.is_published = true;

grant select on public.news_feed_view to anon, authenticated;
