-- ============================================================
--  news-images storage bucket — Phase D (news/articles system)
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor.
--
--  Root cause of the cover/body image upload failing in
--  admin/news.html with "Bucket not found": the "news-images"
--  bucket was referenced by client code (admin/news.html) but was
--  never actually created anywhere -- no SQL in this repo, and it
--  doesn't exist in Supabase Storage either (confirmed via a direct
--  API check). This file creates it plus the matching RLS policies
--  on storage.objects, scoped to this one bucket only. Nothing here
--  touches any other bucket, table, grant, or settlement logic.
--
--  Admin pattern: same as supabase/news_table.sql -- this project's
--  real admin check is the `users.is_admin` boolean column against
--  auth.uid() (see admin/admin.html, admin_settle_event RPC). Reused
--  verbatim here rather than inventing a second pattern.
-- ============================================================

-- ---------- Bucket ----------
-- Public bucket: article/cover images need to be viewable by anyone
-- visiting /news/, same as the existing "site" bucket used for
-- landing images. 3MB client-side limit is enforced in admin/news.html
-- (nwUploadToNewsImages) -- file_size_limit below is a server-side
-- backstop in case that check is ever bypassed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('news-images', 'news-images', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

-- ---------- RLS on storage.objects (scoped to this bucket only) ----------
-- storage.objects already has RLS enabled by default in Supabase --
-- not touched here, only new policies scoped to bucket_id = 'news-images'.

-- Public read -- anyone can view uploaded article images.
create policy news_images_select_public
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'news-images');

-- Admin-only write (insert/update/delete), same is_admin check as
-- the news table itself.
create policy news_images_insert_admin
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'news-images'
    and exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

create policy news_images_update_admin
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'news-images'
    and exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  )
  with check (
    bucket_id = 'news-images'
    and exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );

create policy news_images_delete_admin
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'news-images'
    and exists (
      select 1 from public.users
      where users.id = auth.uid() and users.is_admin = true
    )
  );
