// Local operator only. Privileged key stays in memory; credentials stay outside the repository.
import { readFile, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { config } from '../js/config.js';

const mode = process.argv[2];
const file = join(homedir(), 'Gulievi-admin-access.json');
const ref = new URL(config.supabaseUrl).hostname.split('.')[0];
const env = await readFile(new URL('../.env.management', import.meta.url), 'utf8');
const token = env.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*([^\r\n]+)/m)?.[1].trim().replace(/^['"]|['"]$/g, '');
if (!token?.startsWith('sbp_')) throw new Error('Missing local management authorization.');
async function management(path, method = 'GET', body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Management request failed: HTTP ${response.status}`);
  return response.json();
}
const sql = (query, read_only = true) => management('/database/query', 'POST', { query, read_only });
async function call(path, { method = 'GET', body, bearer, privileged = false, raw = false } = {}) {
  const response = await fetch(config.supabaseUrl + path, {
    method, headers: { apikey: privileged ? serviceKey : config.supabaseKey,
      ...(bearer || privileged ? { Authorization: `Bearer ${bearer || serviceKey}` } : {}),
      'Content-Type': raw ? 'image/webp' : 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data, path: path.split('?')[0] };
}
function checked(result) {
  if (!result.ok) throw new Error(`Auth/data request failed at ${result.path}: HTTP ${result.status}`);
  return result.data;
}
const keys = await management('/api-keys?reveal=true');
const serviceKey = keys.find((key) => key.name === 'service_role')?.api_key;
if (!serviceKey) throw new Error('Server-side service key unavailable.');
try {
  if (mode === 'create') {
    const [state] = await sql('select (select count(*) from auth.users)::int as users, (select count(*) from public.portfolio_admins)::int as admins');
    if (state.users || state.admins) throw new Error('Refusing to replace existing accounts or administrators.');
    if (await access(file).then(() => true, () => false)) throw new Error('Credential file already exists; inspect locally before retrying.');
    const credentials = { url: 'https://gulievi.me/admin/', email: `owner-${randomBytes(8).toString('hex')}@example.com`, password: randomBytes(24).toString('base64url'), note: 'Temporary login, not a mailbox. Change password in admin settings. Keep this file private and delete after saving your new login.' };
    // Save before network write: a timeout must never lose the generated password.
    await writeFile(file, JSON.stringify(credentials, null, 2), { flag: 'wx', mode: 0o600 });
    const user = checked(await call('/auth/v1/admin/users', { method: 'POST', privileged: true, body: { email: credentials.email, password: credentials.password, email_confirm: true } }));
    if (!/^[a-f0-9-]{36}$/.test(user.id)) throw new Error('Invalid created user ID.');
    await sql(`insert into public.portfolio_admins (user_id) values ('${user.id}'::uuid)`, false);
    console.log('OWNER_CREATED. Credentials stored outside repository in Gulievi-admin-access.json in the Windows user profile.');
  } else if (mode === 'cleanup-probes') {
    const probes = await sql("select id from auth.users where email ~ '^probe-[a-f0-9-]{36}@example[.]com$' and id not in (select user_id from public.portfolio_admins)");
    for (const probe of probes) checked(await call(`/auth/v1/admin/users/${probe.id}`, { method: 'DELETE', privileged: true }));
    console.log(`Removed ${probes.length} disposable non-owner test accounts.`);
  } else if (mode === 'test') {
    const credentials = JSON.parse(await readFile(file, 'utf8'));
    let ownerSession;
    let visitorId;
    let visitorSession;
    const photoId = randomUUID();
    let imagePath;
    try {
      ownerSession = checked(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: credentials.email, password: credentials.password } }));
      const owner = (path, options = {}) => call(path, { ...options, bearer: ownerSession.access_token });
      assert.equal(checked(await owner('/rest/v1/rpc/is_portfolio_admin', { method: 'POST', body: {} })), true);
      console.log('PASS actual owner login and membership');
      visitorId = checked(await call('/auth/v1/admin/users', { method: 'POST', privileged: true, body: { email: `probe-${randomUUID()}@example.com`, password: credentials.password, email_confirm: true } })).id;
      const visitorUser = checked(await call(`/auth/v1/admin/users/${visitorId}`, { privileged: true }));
      visitorSession = checked(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: visitorUser.email, password: credentials.password } }));
      const visitor = (path, options = {}) => call(path, { ...options, bearer: visitorSession.access_token });
      assert.equal(checked(await visitor('/rest/v1/rpc/is_portfolio_admin', { method: 'POST', body: {} })), false);
      imagePath = `${ownerSession.user.id}/${randomUUID()}.webp`;
      const image = await readFile(new URL('../images/optimized/hero-bg-480.webp', import.meta.url));
      const deniedPath = `${visitorId}/${randomUUID()}.webp`;
      assert.equal((await visitor(`/storage/v1/object/portfolio/${deniedPath}`, { method: 'POST', body: image, raw: true })).ok, false);
      checked(await owner(`/storage/v1/object/portfolio/${imagePath}`, { method: 'POST', body: image, raw: true }));
      const values = { id: photoId, title: 'Integration test (temporary)', alt: 'Temporary verification photograph', category: 'portraits', sort_order: 999999, published: false, image_path: imagePath, source: 'storage' };
      assert.equal((await visitor('/rest/v1/photos', { method: 'POST', body: values })).ok, false);
      checked(await owner('/rest/v1/photos', { method: 'POST', body: values }));
      assert.equal(checked(await call(`/rest/v1/photos?id=eq.${photoId}&select=id`)).length, 0);
      assert.equal(checked(await visitor(`/rest/v1/photos?id=eq.${photoId}&select=id`)).length, 0);
      checked(await owner(`/rest/v1/photos?id=eq.${photoId}`, { method: 'PATCH', body: { published: true, sort_order: 999998 } }));
      assert.equal(checked(await call(`/rest/v1/photos?id=eq.${photoId}&select=id,sort_order`))[0].sort_order, 999998);
      for (const method of ['PATCH', 'DELETE']) {
        const denied = await visitor(`/rest/v1/photos?id=eq.${photoId}`, { method, ...(method === 'PATCH' ? { body: { title: 'Denied change' } } : {}) });
        assert.ok(!denied.ok || Array.isArray(denied.data) && denied.data.length === 0);
      }
      const deniedDelete = await visitor('/storage/v1/object/portfolio', { method: 'DELETE', body: { prefixes: [imagePath] } });
      assert.ok(!deniedDelete.ok || Array.isArray(deniedDelete.data) && deniedDelete.data.length === 0);
      const stored = await fetch(`${config.supabaseUrl}/storage/v1/object/public/portfolio/${imagePath}`, { signal: AbortSignal.timeout(30000) });
      assert.equal(stored.ok, true);
      ownerSession = checked(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: ownerSession.refresh_token } }));
      assert.equal(checked(await owner('/rest/v1/rpc/is_portfolio_admin', { method: 'POST', body: {} })), true);
      // Exercise password change on the disposable non-owner, never rotate the handed-off owner password in a test.
      const newPassword = randomBytes(24).toString('base64url');
      checked(await visitor('/auth/v1/user', { method: 'PUT', body: { password: newPassword, current_password: credentials.password } }));
      const relogin = checked(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: visitorUser.email, password: newPassword } }));
      checked(await call('/auth/v1/logout', { method: 'POST', bearer: relogin.access_token }));
      assert.equal((await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: visitorUser.email, password: credentials.password } })).ok, false);
      assert.equal(checked(await owner(`/rest/v1/photos?id=eq.${photoId}`, { method: 'DELETE' })).length, 1);
      checked(await owner('/storage/v1/object/portfolio', { method: 'DELETE', body: { prefixes: [imagePath] } }));
      assert.equal(checked(await call(`/rest/v1/photos?id=eq.${photoId}&select=id`)).length, 0);
      console.log('PASS actual owner deletion');
      console.log('PASS actual upload, draft visibility, publish/order, authenticated non-owner denial, refresh and password change');
    } finally {
      // Use privileged cleanup only for the generated IDs, including after a failed assertion.
      // This schema grants table access to authenticated users, not the service_role.
      // Management SQL cleanup is scoped to the freshly generated test UUID.
      await sql(`delete from public.photos where id='${photoId}'::uuid`, false);
      if (imagePath) checked(await call('/storage/v1/object/portfolio', { method: 'DELETE', privileged: true, body: { prefixes: [imagePath] } }));
      if (visitorSession) await call('/auth/v1/logout', { method: 'POST', bearer: visitorSession.access_token });
      if (visitorId) checked(await call(`/auth/v1/admin/users/${visitorId}`, { method: 'DELETE', privileged: true }));
      if (ownerSession) {
        const signedOut = await call('/auth/v1/logout', { method: 'POST', bearer: ownerSession.access_token });
        // A globally revoked session is already logged out.
        if (![401, 403].includes(signedOut.status)) checked(signedOut);
      }
      console.log('Temporary test records cleaned; owner session logged out.');
    }
  } else throw new Error('Use create, test or cleanup-probes.');
} catch (error) {
  // Do not print response bodies, credentials, session tokens or request headers.
  console.error(error.message);
  process.exitCode = 1;
}