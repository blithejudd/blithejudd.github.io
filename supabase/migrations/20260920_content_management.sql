-- Apply AFTER schema.sql. Safe to rerun; does not reset content or photos.
begin;
create table if not exists public.categories (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{0,63}$' and id <> 'all'),
  name text not null check (char_length(trim(name)) between 1 and 100),
  sort_order integer not null default 0 check (sort_order between 0 and 1000000),
  visible boolean not null default true
);
alter table public.categories enable row level security;
revoke all on public.categories from public, anon, authenticated;
grant select on public.categories to anon;
grant select, insert, update, delete on public.categories to authenticated;
drop policy if exists "Public visible categories" on public.categories;
create policy "Public visible categories" on public.categories for select to anon, authenticated using (visible);
drop policy if exists "Owner manages categories" on public.categories;
create policy "Owner manages categories" on public.categories for all to authenticated
  using ((select public.is_portfolio_admin())) with check ((select public.is_portfolio_admin()));

-- Seed only once, so removed/renamed categories do not return on a rerun.
do $$ begin
  if not exists (select 1 from public.portfolio_migrations where name = 'content_management') then
    insert into public.categories (id, name, sort_order) values
      ('editorial', 'ედიტორიალი', 0), ('portraits', 'პორტრეტები', 10),
      ('family', 'ოჯახი', 20), ('weddings', 'ქორწილები', 30) on conflict do nothing;
    insert into public.portfolio_migrations(name) values ('content_management');
  end if;
end $$;
alter table public.photos drop constraint if exists photos_category_check;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.photos'::regclass and conname = 'photos_category_fkey') then
    alter table public.photos add constraint photos_category_fkey foreign key (category) references public.categories(id) on update cascade on delete no action;
  end if;
end $$;
drop policy if exists "Visitors read published photos" on public.photos;
create policy "Visitors read published photos" on public.photos for select to anon, authenticated
  using (published and exists (select 1 from public.categories c where c.id = category and c.visible));

create table if not exists public.site_content (
  id text primary key check (id in ('draft', 'published')),
  "values" jsonb not null default '{}'::jsonb check (jsonb_typeof("values") = 'object' and octet_length("values"::text) <= 1048576),
  revision integer not null default 0 check (revision >= 0)
);
alter table public.site_content enable row level security;
revoke all on public.site_content from public, anon, authenticated;
grant select on public.site_content to anon;
grant select, update on public.site_content to authenticated;
drop policy if exists "Visitors read published content" on public.site_content;
create policy "Visitors read published content" on public.site_content for select to anon, authenticated using (id = 'published');
drop policy if exists "Owner reads content" on public.site_content;
create policy "Owner reads content" on public.site_content for select to authenticated using ((select public.is_portfolio_admin()));
drop policy if exists "Owner edits content" on public.site_content;
create policy "Owner edits content" on public.site_content for update to authenticated
  using ((select public.is_portfolio_admin())) with check ((select public.is_portfolio_admin()));
insert into public.site_content(id) values ('draft'), ('published') on conflict do nothing;
commit;
