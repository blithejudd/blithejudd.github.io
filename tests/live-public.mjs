// Explicit live checks: public reads and denied writes to isolated probe IDs only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { config } from '../js/config.js';

async function request(path, method = 'GET', body, extra = {}) {
  return fetch(config.supabaseUrl + path, {
    method, headers: { apikey: config.supabaseKey, ...extra }, body,
    signal: AbortSignal.timeout(20000),
  });
}
async function denied(label, path, method, body, extra) {
  const response = await request(path, method, body, extra);
  const result = await response.json();
  const status = Number(result.statusCode || response.status);
  assert.ok([401, 403].includes(status), `${label}: unexpected HTTP ${response.status}, status ${status}`);
  console.log(`PASS ${label} denied (${status})`);
}
const auth = await request('/auth/v1/settings');
assert.equal(auth.status, 200);
assert.equal((await auth.json()).disable_signup, true);
console.log('PASS public signup disabled');
const response = await request('/rest/v1/photos?select=*&order=sort_order.asc&published=eq.true');
assert.equal(response.status, 200);
const photos = await response.json();
assert.equal(photos.length, 6);
assert.ok(photos.every((photo) => photo.published && photo.source === 'local'));
assert.ok(photos.some((photo) => photo.title.includes('პორტრეტი')));
console.log('PASS six published photos with Georgian metadata from live database');

const probe = crypto.randomUUID();
const json = { 'Content-Type': 'application/json' };
await denied('anonymous insert', '/rest/v1/photos', 'POST', JSON.stringify({
  id: probe, title: 'Security probe', alt: 'Security probe', category: 'portraits',
  image_path: `images/security-probe-${probe}.webp`, source: 'local', sort_order: 999999, published: false,
}), json);
await denied('anonymous update', `/rest/v1/photos?id=eq.${probe}`, 'PATCH', JSON.stringify({ title: 'Denied' }), json);
await denied('anonymous delete', `/rest/v1/photos?id=eq.${probe}`, 'DELETE');
await denied('private owner list', '/rest/v1/portfolio_admins?select=*');
await denied('private quota RPC', '/rest/v1/rpc/consume_contact_quota', 'POST', JSON.stringify({ contact_hash: 'a'.repeat(64) }), json);
const storagePath = `${probe}/${crypto.randomUUID()}.webp`;
await denied('anonymous storage upload', `/storage/v1/object/portfolio/${storagePath}`, 'POST',
  await readFile(new URL('../images/optimized/hero-bg-480.webp', import.meta.url)), { 'Content-Type': 'image/webp' });
// Check delete policy separately via SQL role tests; Storage may return success for zero deleted rows.
console.log('ALL LIVE PUBLIC TESTS PASSED');