// Local operator tool. Never served by the preview server; no credentials are logged.
import { readFile } from 'node:fs/promises';
import { config } from '../js/config.js';

const mode = process.argv[2];
if (!['inspect', 'provision', 'audit'].includes(mode)) throw new Error('Use inspect, provision or audit.');
const env = await readFile(new URL('../.env.management', import.meta.url), 'utf8');
const token = env.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*([^\r\n]+)/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
if (!token?.startsWith('sbp_')) throw new Error('Local Management API token is missing.');
const ref = new URL(config.supabaseUrl).hostname.split('.')[0];

async function management(path, method = 'GET', body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Management ${path}: HTTP ${response.status}`);
  return response.json();
}
const sql = (query, read_only = true) => management('/database/query', 'POST', { query, read_only });

try {
  if (mode === 'inspect' || mode === 'provision') {
    const [state] = await sql(`select
      (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')::int as public_tables,
      (select count(*) from storage.buckets)::int as buckets,
      (select count(*) from pg_policies where schemaname in ('public','storage'))::int as policies,
      (select count(*) from auth.users)::int as users`);
    console.log(JSON.stringify(state));
    if (mode === 'provision') {
      if (state.public_tables || state.buckets || state.policies || state.users) throw new Error('Project is not empty; inspect before applying SQL.');
      await sql(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'), false);
      console.log('SCHEMA_APPLIED');
      const auth = await management('/config/auth', 'PATCH', { disable_signup: true, site_url: 'https://gulievi.me' });
      console.log(JSON.stringify({ disable_signup: auth.disable_signup, site_url: auth.site_url }));
    }
  }
  if (mode === 'audit') {
    console.log(JSON.stringify(await sql(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`)));
    console.log(JSON.stringify(await sql(`select count(*)::int as photos, count(*) filter(where published)::int as published from public.photos`)));
    console.log(JSON.stringify(await sql(`select id, public, file_size_limit, allowed_mime_types from storage.buckets where id='portfolio'`)));
    console.log(JSON.stringify(await sql(`select count(*)::int as admins from public.portfolio_admins`)));
    const auth = await management('/config/auth');
    console.log(JSON.stringify({ disable_signup: auth.disable_signup, site_url: auth.site_url }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}