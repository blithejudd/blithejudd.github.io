-- After schema.sql and 20260920_content_management.sql. No existing environment
-- secrets are copied or rotated. Managed Telegram starts disabled.
begin;
create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
revoke all on schema vault from public, anon, authenticated;
revoke all on vault.secrets, vault.decrypted_secrets from public, anon, authenticated;

create table if not exists public.integration_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  bot_secret uuid references vault.secrets(id) on delete set null,
  chat_secret uuid references vault.secrets(id) on delete set null,
  salt_secret uuid references vault.secrets(id) on delete set null,
  allowed_origins text[] not null default array['https://gulievi.me','https://blithejudd.github.io'],
  revision integer not null default 0 check (revision >= 0)
);
alter table public.integration_settings enable row level security;
revoke all on public.integration_settings from public, anon, authenticated;
insert into public.integration_settings(id) values(true) on conflict do nothing;
do $$ begin
  if exists(select 1 from public.integration_settings where id and salt_secret is null) then
    update public.integration_settings set salt_secret = vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')) where id and salt_secret is null;
  end if;
end $$;

create or replace function public.connection_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.integration_settings;
begin
  if not coalesce(public.is_portfolio_admin(),false) then raise exception 'Owner access required' using errcode='42501'; end if;
  select * into strict s from public.integration_settings where id;
  return jsonb_build_object('enabled',s.enabled,'tokenConfigured',s.bot_secret is not null,'chatConfigured',s.chat_secret is not null,'saltConfigured',s.salt_secret is not null,'allowedOrigins',s.allowed_origins,'revision',s.revision);
end $$;

create or replace function public.save_connections(p_revision integer, p_enabled boolean, p_bot_token text default null, p_chat_id text default null, p_hash_salt text default null, p_origins text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.integration_settings; origin text;
begin
  if not coalesce(public.is_portfolio_admin(),false) then raise exception 'Owner access required' using errcode='42501'; end if;
  select * into strict s from public.integration_settings where id for update;
  if p_revision is null or p_revision <> s.revision then raise exception 'Configuration changed' using errcode='40001'; end if;
  if p_enabled is null then raise exception 'Invalid configuration' using errcode='22023'; end if;
  if p_bot_token is not null and (length(p_bot_token)>200 or p_bot_token !~ '^[0-9]{5,20}:[A-Za-z0-9_-]{30,100}$') then raise exception 'Invalid bot token' using errcode='22023'; end if;
  if p_chat_id is not null and p_chat_id !~ '^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$' then raise exception 'Invalid chat ID' using errcode='22023'; end if;
  if p_hash_salt is not null and (length(p_hash_salt)<32 or length(p_hash_salt)>256 or p_hash_salt ~ '[[:space:]]') then raise exception 'Invalid hash salt' using errcode='22023'; end if;
  if p_origins is not null then
    if cardinality(p_origins)<1 or cardinality(p_origins)>20 then raise exception 'Invalid origins' using errcode='22023'; end if;
    foreach origin in array p_origins loop
      if origin is null or length(origin)>253 or origin !~ '^(https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?([:][0-9]{1,5})?|http://(localhost|127[.]0[.]0[.]1)([:][0-9]{1,5})?)$' then raise exception 'Invalid origin' using errcode='22023'; end if;
    end loop;
    s.allowed_origins := p_origins;
  end if;
  if p_bot_token is not null then
    if s.bot_secret is null then s.bot_secret := vault.create_secret(p_bot_token); else perform vault.update_secret(s.bot_secret,p_bot_token); end if;
  end if;
  if p_chat_id is not null then
    if s.chat_secret is null then s.chat_secret := vault.create_secret(p_chat_id); else perform vault.update_secret(s.chat_secret,p_chat_id); end if;
  end if;
  if p_hash_salt is not null then
    if s.salt_secret is null then s.salt_secret := vault.create_secret(p_hash_salt); else perform vault.update_secret(s.salt_secret,p_hash_salt); end if;
  end if;
  if p_enabled and (s.bot_secret is null or s.chat_secret is null or s.salt_secret is null) then raise exception 'Configuration incomplete' using errcode='22023'; end if;
  update public.integration_settings set enabled=p_enabled,bot_secret=s.bot_secret,chat_secret=s.chat_secret,salt_secret=s.salt_secret,allowed_origins=s.allowed_origins,revision=s.revision+1 where id;
  return public.connection_status();
end $$;

create or replace function public.public_connection_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('contactEnabled',enabled and bot_secret is not null and chat_secret is not null and salt_secret is not null) from public.integration_settings where id;
$$;

-- Only Edge Functions using the platform service role can read plaintext.
create or replace function public.contact_runtime()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled',s.enabled,'token',(select decrypted_secret from vault.decrypted_secrets where id=s.bot_secret),'chatId',(select decrypted_secret from vault.decrypted_secrets where id=s.chat_secret),'salt',(select decrypted_secret from vault.decrypted_secrets where id=s.salt_secret),'allowedOrigins',s.allowed_origins)
  from public.integration_settings s where s.id;
$$;
revoke all on function public.connection_status() from public, anon, authenticated;
revoke all on function public.save_connections(integer,boolean,text,text,text,text[]) from public, anon, authenticated;
revoke all on function public.public_connection_settings() from public, anon, authenticated;
revoke all on function public.contact_runtime() from public, anon, authenticated;
grant execute on function public.connection_status(), public.save_connections(integer,boolean,text,text,text,text[]) to authenticated;
grant execute on function public.public_connection_settings() to anon, authenticated;
grant execute on function public.contact_runtime() to service_role;
commit;
