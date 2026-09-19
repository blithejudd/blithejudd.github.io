// Read-only deployment check. No GitHub credential is needed for this public repo.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const runId = process.argv[2];
if (!/^\d+$/.test(runId || '')) throw new Error('Pass the GitHub Actions run ID.');
const headers = { 'User-Agent': 'portfolio-deployment-check', 'Cache-Control': 'no-cache' };
const get = (url) => fetch(url, { headers, signal: AbortSignal.timeout(20000) });
try {
  let deployed = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const response = await get(`https://api.github.com/repos/blithejudd/blithejudd.github.io/actions/runs/${runId}`);
    assert.equal(response.status, 200);
    const run = await response.json();
    console.log(`Pages ${run.status}: ${run.conclusion || 'pending'}`);
    if (run.status === 'completed') {
      assert.equal(run.conclusion, 'success');
      deployed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  assert.ok(deployed, 'Pages deployment did not finish within polling window.');
  for (const path of ['index.html', 'admin/index.html', 'css/site.css', 'css/admin.css', 'js/config.js', 'js/api.js', 'js/main.js', 'js/admin.js', 'images/optimized/hero-bg-480.webp', 'CNAME']) {
    const response = await get(`https://gulievi.me/${path}?deployment=${runId}`);
    assert.equal(response.status, 200, path);
    const actual = Buffer.from(await response.arrayBuffer());
    const expected = await readFile(new URL(`../${path}`, import.meta.url));
    if (path.endsWith('.webp')) assert.deepEqual(actual, expected, path);
    else assert.equal(actual.toString('utf8').replace(/\r\n/g, '\n'), expected.toString('utf8').replace(/\r\n/g, '\n'), path);
    console.log(`PASS deployed ${path}`);
  }
  for (const path of ['.env.management', '.env.management.txt']) {
    const response = await get(`https://gulievi.me/${path}`);
    assert.equal(response.status, 404, 'Local secret file must not be deployed.');
    console.log(`PASS not exposed ${path}`);
  }
  console.log('DEPLOYMENT VERIFIED');
} catch (error) {
  // Avoid dumping response bodies or assertion actual/expected values.
  console.error(`Deployment check failed: ${error.code || error.name}`);
  process.exitCode = 1;
}