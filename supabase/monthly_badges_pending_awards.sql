-- ============================================================
--  monthly_badges split: image-upload vs award
--  Migration from the single monthly_badges table (already applied,
--  per supabase/monthly_badges.sql) to two tables so a badge IMAGE can
--  be uploaded for a period before that period's winner is known.
-- ============================================================
--  NOT APPLIED. Run this manually in the Supabase SQL Editor, against
--  a database that already has public.monthly_badges (the original
--  single-table version). Nothing here touches any other table, grant,
--  RLS policy, or settlement/balance/ticket/cron logic. No row is
--  dropped — the old table is renamed, not deleted, so existing data
--  is recoverable if anything here needs to be undone.
--
--  Why two tables:
--    monthly_badge_images — one row per (sport, period_year,
--    period_month): the uploaded picture. Can exist for a period that
--    hasn't ended yet. resolved_at is null until that period has been
--    processed (by whatever mechanism ends up awarding it — not part
--    of this file); non-null once processing ran, whether or not any
--    award rows resulted (a period with zero score_history activity
--    is resolved with zero winners, not left pending forever).
--
--    monthly_badge_awards — one row per winner. Ties are still
--    allowed: multiple rows can point at the same badge_image_id.
--    Created either immediately (admin uploads for an already-completed
--    month, so the winner is already known — same flow as before) or
--    later by whatever resolver mechanism is agreed on separately.
--
--  This file does NOT add that resolver. It only reshapes the table
--  so a pending (unresolved) image can exist. The automatic-awarding
--  piece is a separate, explicitly-approved-first change per the
--  instructions this was written under.
-- ============================================================

-- ---------- Tables ----------

create table if not exists public.monthly_badge_images (
  id            uuid primary key default gen_random_uuid(),
  sport         text not null default 'ufc',
  period_year   int not null,
  period_month  int not null
                  constraint monthly_badge_images_month_range
                  check (period_month between 1 and 12),
  image_url     text not null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,

  constraint monthly_badge_images_unique_period
    unique (sport, period_year, period_month)
);

create index if not exists monthly_badge_images_period_idx
  on public.monthly_badge_images (sport, period_year desc, period_month desc);

create table if not exists public.monthly_badge_awards (
  id              uuid primary key default gen_random_uuid(),
  badge_image_id  uuid not null references public.monthly_badge_images(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  awarded_at      timestamptz not null default now(),

  constraint monthly_badge_awards_unique_winner
    unique (badge_image_id, user_id)
);

-- Lookup index for a future "this user's badges, newest period first"
-- query (profile page, not yet built — same intent as the single-table
-- version's monthly_badges_user_period_idx). Join to
-- monthly_badge_images for period_year/period_month ordering.
create index if not exists monthly_badge_awards_user_idx
  on public.monthly_badge_awards (user_id);

alter table public.monthly_badge_images enable row level security;
alter table public.monthly_badge_awards enable row level security;

revoke all on public.monthly_badge_images from public;
revoke all on public.monthly_badge_awards from public;

-- ---------- SELECT (public read, same reasoning as the original table:
-- no anon, matches get_public_profile's authenticated-only pattern) ----------

create policy monthly_badge_images_select_authenticated
  on public.monthly_badge_images
  for select
  to authenticated
  using (true);

create policy monthly_badge_awards_select_authenticated
  on public.monthly_badge_awards
  for select
  to authenticated
  using (true);

-- ---------- WRITE (admin only) ----------
-- Same inline users.is_admin check as the original table. If/when an
-- automatic resolver is added, it runs as a SECURITY DEFINER function
-- (owned by postgres) and bypasses these policies entirely, the same
-- way settle_nba_tickets etc. already bypass RLS for their own tables
-- — these admin-only policies are not expected to need changing for it.

create policy monthly_badge_images_insert_admin
  on public.monthly_badge_images
  for insert
  to authenticated
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );

create policy monthly_badge_images_update_admin
  on public.monthly_badge_images
  for update
  to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  )
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );

create policy monthly_badge_images_delete_admin
  on public.monthly_badge_images
  for delete
  to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );

create policy monthly_badge_awards_insert_admin
  on public.monthly_badge_awards
  for insert
  to authenticated
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );

create policy monthly_badge_awards_update_admin
  on public.monthly_badge_awards
  for update
  to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  )
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );

create policy monthly_badge_awards_delete_admin
  on public.monthly_badge_awards
  for delete
  to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );

-- ---------- GRANTs ----------

grant select on public.monthly_badge_images to authenticated;
grant insert, update, delete on public.monthly_badge_images to authenticated;
grant all on public.monthly_badge_images to service_role;

grant select on public.monthly_badge_awards to authenticated;
grant insert, update, delete on public.monthly_badge_awards to authenticated;
grant all on public.monthly_badge_awards to service_role;

-- ---------- Data migration ----------
-- Every row previously written by admin.html's awardBadge() shares one
-- image_url per (sport, period_year, period_month) — the storage path
-- is `${sport}/${year}-${month}`, deterministic and upload-once per
-- period, so all tied winners in a period already point at the same
-- file. Grouping by period and taking any one image_url in the group
-- is therefore lossless.

insert into public.monthly_badge_images (sport, period_year, period_month, image_url, created_at, resolved_at)
select
  b.sport,
  b.period_year,
  b.period_month,
  (array_agg(b.image_url order by b.awarded_at))[1] as image_url,
  min(b.awarded_at) as created_at,
  min(b.awarded_at) as resolved_at  -- already-awarded historical rows count as already-resolved
from public.monthly_badges b
group by b.sport, b.period_year, b.period_month
on conflict (sport, period_year, period_month) do nothing;

insert into public.monthly_badge_awards (badge_image_id, user_id, awarded_at)
select i.id, b.user_id, b.awarded_at
from public.monthly_badges b
join public.monthly_badge_images i
  on i.sport = b.sport
  and i.period_year = b.period_year
  and i.period_month = b.period_month
on conflict (badge_image_id, user_id) do nothing;

-- ---------- Old table: renamed, not dropped ----------
-- Policies and grants on the old table stay attached under its new
-- name — harmless and unused going forward, left as-is rather than
-- dropped, so nothing here needs to touch them.

alter table public.monthly_badges rename to monthly_badges_deprecated;

-- Once you've confirmed admin.html's badge card works end-to-end
-- against the two new tables and the row counts below match your
-- expectations, this old table can be dropped manually:
--   drop table public.monthly_badges_deprecated;

-- ---------- Verification queries (read-only, run these yourself) ----------
-- select count(*) from public.monthly_badges_deprecated;
-- select count(*) from public.monthly_badge_images;
-- select count(*) from public.monthly_badge_awards;
-- -- awards count should equal monthly_badges_deprecated's row count;
-- -- images count should equal the number of distinct (sport, period_year, period_month) in it.
