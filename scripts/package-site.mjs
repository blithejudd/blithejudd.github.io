// Explicit deployment allowlist. Operator scripts, tests and local data are never served.
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url), output = new URL('_site/', root);
await mkdir(output, { recursive: true });
assert.equal((await readdir(output)).length, 0, 'Package directory must be empty; use a fresh checkout for deployment.');
const entries = ['index.html','admin','css','js','fonts','images','favicon.svg','robots.txt','sitemap.xml','CNAME','.nojekyll'];
for (const entry of entries) await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
const { config } = await import('../js/config.js');
assert.match(config.supabaseUrl, /^https:\/\/[a-z0-9-]+\.supabase\.co$/);
assert.notEqual(config.preview, true);
for (const file of ['admin/index.html','js/admin.js','js/config.js']) {
  const text = await readFile(new URL(file, output), 'utf8');
  assert.doesNotMatch(text, /demo-password|demo@example\.com|sb_secret_|sbp_/);
}
console.log('Public site packaged; local backend, credentials, attachments and test results excluded.');
