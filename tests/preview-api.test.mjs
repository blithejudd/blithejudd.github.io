import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPreviewApi } from '../scripts/preview-api.mjs';

test('local CMS persists edits and isolates drafts/hidden categories from visitors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zuka-cms-check-'));
  let server;
  const start = async () => {
    const api = await createPreviewApi(root);
    server = http.createServer(async (request, response) => {
      try { if (!await api(new URL(request.url, 'http://localhost'), request, response)) { response.writeHead(404); response.end(); } }
      catch { response.writeHead(500); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}/preview-api`;
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  try {
    let base = await start();
    let token = '';
    const request = async (route, method = 'GET', body, authenticated = false) => {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    token = (await request('/auth/v1/token?grant_type=password', 'POST', { email: 'demo@example.com', password: 'demo-password' })).data.access_token;
    assert.ok(token);
    assert.equal((await request('/rest/v1/categories', 'POST', { id: 'blocked' })).status, 403);
    assert.deepEqual((await request('/rest/v1/site_content')).data.map((row) => row.id), ['published']);
    const category = { id: 'architecture', name: 'არქიტექტურა', sort_order: 5, visible: true };
    assert.equal((await request('/rest/v1/categories', 'POST', category, true)).status, 200);
    const photo = { title: 'სივრცე', alt: 'სივრცე', category: category.id, published: true, sort_order: 0, source: 'local', image_path: 'images/about.webp' };
    assert.equal((await request('/rest/v1/photos', 'POST', photo, true)).status, 200);
    assert.equal((await request('/rest/v1/categories?id=eq.architecture', 'DELETE', null, true)).status, 409);
    await request('/rest/v1/categories?id=eq.architecture', 'PATCH', { visible: false }, true);
    assert.equal((await request('/rest/v1/photos')).data.length, 6);
    assert.equal((await request('/rest/v1/photos', 'GET', null, true)).data.length, 7);
    const values = { 'hero.visible': false };
    assert.equal((await request('/rest/v1/site_content?id=eq.draft&revision=eq.0', 'PATCH', { values, revision: 1 }, true)).data[0].revision, 1);
    assert.deepEqual((await request('/rest/v1/site_content?id=eq.draft&revision=eq.0', 'PATCH', { values: {} }, true)).data, []);
    assert.deepEqual((await request('/rest/v1/site_content')).data[0].values, {});
    await request('/rest/v1/site_content?id=eq.published&revision=eq.0', 'PATCH', { values, revision: 1 }, true);
    const settings={p_revision:0,p_enabled:true,p_bot_token:'demo-bot-token',p_chat_id:'demo-chat-id',p_hash_salt:null,p_origins:['http://localhost:4173']};
    assert.equal((await request('/rest/v1/rpc/connection_status','POST',{})).status,403);
    assert.equal((await request('/rest/v1/rpc/contact_runtime','POST',{},true)).status,403);
    assert.equal((await request('/rest/v1/rpc/save_connections','POST',settings)).status,403);
    assert.equal((await request('/rest/v1/rpc/save_connections','POST',{...settings,p_bot_token:'123456:'+ 'x'.repeat(35)},true)).status,400);
    const saved=(await request('/rest/v1/rpc/save_connections','POST',settings,true)).data;
    assert.equal(saved.tokenConfigured,true); assert.equal(saved.enabled,true);
    assert.equal(JSON.stringify(saved).includes('demo-bot-token'),false);
    assert.equal((await readFile(path.join(root,'test-results','cms-preview.json'),'utf8')).includes('demo-bot-token'),false);
    assert.deepEqual((await request('/functions/v1/connections','POST',{action:'test_telegram'},true)).data,{botValid:true,chatReachable:true,simulated:true});
    await close(); base = await start();
    assert.deepEqual((await request('/rest/v1/site_content')).data[0].values, values);
    assert.equal((await request('/rest/v1/photos')).data.length, 6);
    assert.deepEqual((await request('/rest/v1/rpc/public_connection_settings','POST',{})).data,{contactEnabled:true});
  } finally {
    if (server.listening) await close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('zuka-cms-check-'));
    await rm(root, { recursive: true, force: true });
  }
});
