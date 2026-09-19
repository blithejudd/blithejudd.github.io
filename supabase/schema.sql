-- Run once in the SQL Editor of a NEW, dedicated Supabase project.
-- Re-running is supported; existing photos and admin assignments are preserved.
begin;

create table if not exists public.portfolio_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.portfolio_admins enable row level security;
revoke all on public.portfolio_admins from anon, authenticated;

create or replace function public.is_portfolio_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.portfolio_admins where user_id = (select auth.uid())); $$;
revoke all on function public.is_portfolio_admin() from public, anon;
grant execute on function public.is_portfolio_admin() to authenticated;

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 160),
  alt text not null check (char_length(trim(alt)) between 1 and 300),
  category text not null check (category in ('editorial', 'portraits', 'family', 'weddings')),
  image_path text not null unique,
  source text not null check (source in ('local', 'storage')),
  sort_order integer not null default 0 check (sort_order between 0 and 1000000),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  constraint photo_path_valid check (
    (source = 'local' and image_path ~ '^images/[a-z0-9-]+\.webp$') or
    (source = 'storage' and image_path ~ '^[a-f0-9-]+/[a-f0-9-]+\.webp$')
  )
);
create index if not exists photos_display_order on public.photos (published, sort_order, id);
alter table public.photos enable row level security;
revoke all on public.photos from anon, authenticated;
grant select on public.photos to anon;
grant select, insert, update, delete on public.photos to authenticated;
drop policy if exists "Visitors read published photos" on public.photos;
create policy "Visitors read published photos" on public.photos for select to anon, authenticated using (published = true);
drop policy if exists "Owner manages photos" on public.photos;
create policy "Owner manages photos" on public.photos for all to authenticated
  using ((select public.is_portfolio_admin())) with check ((select public.is_portfolio_admin()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portfolio', 'portfolio', true, 8388608, array['image/webp'])
on conflict (id) do update set public = true, file_size_limit = 8388608, allowed_mime_types = array['image/webp'];

drop policy if exists "Owner reads portfolio storage" on storage.objects;
create policy "Owner reads portfolio storage" on storage.objects for select to authenticated
  using (bucket_id = 'portfolio' and (select public.is_portfolio_admin()));
drop policy if exists "Owner uploads portfolio storage" on storage.objects;
create policy "Owner uploads portfolio storage" on storage.objects for insert to authenticated
  with check (bucket_id = 'portfolio' and (select public.is_portfolio_admin())
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[a-f0-9-]+/[a-f0-9-]+\.webp$');
drop policy if exists "Owner deletes portfolio storage" on storage.objects;
create policy "Owner deletes portfolio storage" on storage.objects for delete to authenticated
  using (bucket_id = 'portfolio' and (select public.is_portfolio_admin()));
-- No UPDATE/UPSERT policy: every uploaded file gets an immutable random path.

-- Initial metadata points to images already on GitHub Pages; no duplicate uploads.
-- A private migration marker avoids resurrecting photos even after ALL were deleted.
create table if not exists public.portfolio_migrations (name text primary key);
alter table public.portfolio_migrations enable row level security;
revoke all on public.portfolio_migrations from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from public.portfolio_migrations where name = 'initial_photos') then
    insert into public.photos (id, image_path, title, alt, category, sort_order, published, source) values
    ('00000000-0000-4000-8000-000000000001', 'images/hero-bg.webp', 'ედიტორიალური პორტრეტი', 'ედიტორიალური პორტრეტი', 'editorial', 10, true, 'local'),
    ('00000000-0000-4000-8000-000000000002', 'images/portfolio-4.webp', 'მშვიდი მზერა', 'მშვიდი მზერა', 'portraits', 20, true, 'local'),
    ('00000000-0000-4000-8000-000000000003', 'images/portfolio-1.webp', 'ოჯახური მომენტები', 'ოჯახური მომენტები', 'family', 30, true, 'local'),
    ('00000000-0000-4000-8000-000000000004', 'images/portfolio-2.webp', 'ერთად ყოფნა', 'ერთად ყოფნა', 'family', 40, true, 'local'),
    ('00000000-0000-4000-8000-000000000005', 'images/portfolio-3.webp', 'პატარა ბედნიერება', 'პატარა ბედნიერება', 'family', 50, true, 'local'),
    ('00000000-0000-4000-8000-000000000006', 'images/portfolio-5.webp', 'ჩვენი ისტორია', 'ჩვენი ისტორია', 'family', 60, true, 'local')
    on conflict do nothing;
    insert into public.portfolio_migrations (name) values ('initial_photos');
  end if;
end $$;

-- Contact abuse protection; clients cannot access the table or call this RPC.
create table if not exists public.contact_rate_limits (
  key text primary key,
  window_start timestamptz not null,
  attempts integer not null
);
alter table public.contact_rate_limits enable row level security;
revoke all on public.contact_rate_limits from public, anon, authenticated;

create or replace function public.consume_contact_quota(contact_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare global_count integer; contact_count integer;
begin
  if contact_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  delete from public.contact_rate_limits where window_start < now() - interval '2 hours';
  insert into public.contact_rate_limits as r (key, window_start, attempts) values ('global', now(), 1)
  on conflict (key) do update set
    attempts = case when r.window_start < now() - interval '1 hour' then 1 else r.attempts + 1 end,
    window_start = case when r.window_start < now() - interval '1 hour' then now() else r.window_start end
  returning attempts into global_count;
  if global_count > 30 then return false; end if;
  insert into public.contact_rate_limits as r (key, window_start, attempts) values (contact_hash, now(), 1)
  on conflict (key) do update set
    attempts = case when r.window_start < now() - interval '1 hour' then 1 else r.attempts + 1 end,
    window_start = case when r.window_start < now() - interval '1 hour' then now() else r.window_start end
  returning attempts into contact_count;
  return contact_count <= 3;
end $$;
revoke all on function public.consume_contact_quota(text) from public, anon, authenticated;
grant execute on function public.consume_contact_quota(text) to service_role;

commit;