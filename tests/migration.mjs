// Optional local PostgreSQL check. Install the test-only engine as documented in docs/CMS.md.
import { PGlite } from '../test-results/sql-check/node_modules/@electric-sql/pglite/dist/index.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = new PGlite();
const owner = '11111111-1111-4111-8111-111111111111';
try {
  // Only Supabase infrastructure is stubbed; application SQL and RLS run unmodified.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public, storage to anon, authenticated, service_role;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1, '/') $$;
    insert into auth.users values ('${owner}');
  `);
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../supabase/migrations/20260920_content_management.sql', import.meta.url), 'utf8');
  await db.exec(schema); await db.exec(migration); await db.exec(migration);
  assert.equal((await db.query('select count(*)::int as n from photos')).rows[0].n, 6);
  await db.query('insert into portfolio_admins values ($1)', [owner]);
  await db.exec(`set role anon;`);
  assert.deepEqual((await db.query('select id from site_content')).rows.map((row) => row.id), ['published']);
  await assert.rejects(db.query("insert into categories(id,name) values ('blocked','blocked')"));
  await assert.rejects(db.query("update site_content set revision=1 where id='published'"));
  await db.exec("reset role; set role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);");
  assert.deepEqual((await db.query('select id from site_content')).rows.map((row) => row.id), ['published']);
  assert.equal((await db.query("update site_content set revision=1 where id='published'")).affectedRows, 0);
  await assert.rejects(db.query("insert into categories(id,name) values ('blocked','blocked')"));
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false);`);
  assert.equal((await db.query('select id from site_content')).rows.length, 2);
  await db.query("insert into categories(id,name,sort_order) values ('architecture','არქიტექტურა',5)");
  await db.query("update photos set category='architecture' where category='editorial'");
  await assert.rejects(db.query("delete from categories where id='architecture'"), (error) => error.code === '23503');
  await db.query("update categories set visible=false where id='architecture'");
  assert.equal((await db.query('select count(*)::int as n from photos')).rows[0].n, 6, 'owner sees hidden category photos');
  assert.equal((await db.query(`update site_content set "values"='{"hero.visible":false}',revision=1 where id='draft' and revision=0`)).affectedRows, 1);
  assert.equal((await db.query(`update site_content set "values"='{}',revision=1 where id='draft' and revision=0`)).affectedRows, 0, 'stale revision cannot overwrite');
  await db.exec('reset role; set role anon;');
  assert.equal((await db.query('select count(*)::int as n from photos')).rows[0].n, 5, 'hidden category photos excluded by RLS');
  assert.deepEqual((await db.query('select "values" from site_content')).rows[0].values, {}, 'draft not exposed');
  await db.exec('reset role;');
  await db.exec(migration);
  assert.equal((await db.query("select visible from categories where id='architecture'")).rows[0].visible, false);
  assert.equal((await db.query("select revision from site_content where id='draft'")).rows[0].revision, 1);
  console.log('PASS real PostgreSQL migration, rerun safety, anonymous/non-owner denial, private drafts, owner writes, category FK and visibility, revision conflicts');
  // Supabase Vault crypto is a platform extension. Stub only its API in-memory;
  // permissions, owner checks, replacement transactions and returned data are real SQL.
  await db.exec(`
    create schema vault;
    create table vault.secrets(id uuid primary key default gen_random_uuid(), secret text);
    create view vault.decrypted_secrets as select id, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(text) returns uuid language plpgsql as $$ declare result uuid; begin insert into vault.secrets(secret) values($1) returning id into result; return result; end $$;
    create function vault.update_secret(uuid,text) returns void language sql as $$ update vault.secrets set secret=$2 where id=$1 $$;
  `);
  const connections = (await readFile(new URL('../supabase/migrations/20260921_connections.sql', import.meta.url), 'utf8')).replace('create extension if not exists supabase_vault with schema vault;', '-- Vault API is stubbed above for this test.');
  await db.exec(connections); await db.exec(connections);
  await db.exec('set role anon;');
  assert.deepEqual((await db.query('select public_connection_settings() as s')).rows[0].s, { contactEnabled: false });
  for (const sql of ['select * from integration_settings', 'select * from vault.decrypted_secrets', 'select connection_status()', 'select contact_runtime()', 'select save_connections(0,false)']) await assert.rejects(db.query(sql));
  await db.exec("reset role; set role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);");
  await assert.rejects(db.query('select connection_status()'));
  await assert.rejects(db.query('select save_connections(0,false)'));
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false);`);
  await assert.rejects(db.query('select contact_runtime()'), 'even owner browser cannot read plaintext');
  await assert.rejects(db.query('select * from vault.decrypted_secrets'));
  const fakeToken = '123456:' + 'x'.repeat(35), fakeChat = '-7654321', fakeSalt = 'q'.repeat(40);
  const saved = (await db.query('select save_connections($1,$2,$3,$4,$5,$6) as s', [0,true,fakeToken,fakeChat,fakeSalt,['https://gulievi.me']])).rows[0].s;
  assert.equal(saved.revision,1); assert.equal(saved.enabled,true); assert.equal(saved.tokenConfigured,true);
  for (const secret of [fakeToken,fakeChat,fakeSalt]) assert.equal(JSON.stringify(saved).includes(secret),false);
  await assert.rejects(db.query('select save_connections(0,false)'), (error) => error.code === '40001');
  await assert.rejects(db.query('select save_connections(1,true,$1)', ['invalid']), (error) => error.code === '22023');
  assert.equal((await db.query('select connection_status() as s')).rows[0].s.revision,1);
  await db.query('select save_connections(1,false)');
  await db.exec('reset role; set role service_role;');
  const backend = (await db.query('select contact_runtime() as s')).rows[0].s;
  assert.equal(backend.token,fakeToken); assert.equal(backend.chatId,fakeChat); assert.equal(backend.salt,fakeSalt); assert.equal(backend.enabled,false);
  await db.exec('reset role;'); await db.exec(connections);
  assert.equal((await db.query('select revision from integration_settings')).rows[0].revision,2);
  console.log('PASS connections SQL: private Vault API, owner-only replacement, secret-free read status, service-only plaintext, disable, conflict and rerun safety');
} finally { await db.close(); }
