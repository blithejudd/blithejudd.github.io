// Browser integration tests without npm dependencies. Uses installed Chromium via CDP.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initialPhotos } from '../js/data.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'zuka-browser-'));
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs')], { stdio: 'ignore' });
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let sessionId;
let sequence = 0;
const pending = new Map();
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(method, params = {}, session = sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error(`Condition timeout: ${expression}; page=${await evaluate('location.href + " " + document.body.innerText.slice(0, 300)')}; errors=${JSON.stringify(errors)}`);
}
async function go(relative) {
  await command('Page.navigate', { url: `http://127.0.0.1:4173/${relative}` });
  await delay(400);
  await waitFor('document.readyState === "complete"');
}
async function screenshot(name) {
  await evaluate('Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))');
  await delay(150);
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(result.data, 'base64'));
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    chrome.once('error', reject);
    chrome.stderr.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let intercept = null;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id); pending.delete(message.id);
      if (callback) message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    else if (message.method === 'Fetch.requestPaused' && intercept) intercept(message.params).catch((error) => errors.push(error.message));
  });
  const target = await command('Target.createTarget', { url: 'about:blank' }, null);
  sessionId = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await command('Page.enable'); await command('Runtime.enable');
  // Always test setup mode in isolation, even when the site has live credentials.
  intercept = async ({ requestId }) => command('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
    body: Buffer.from('export const config = { supabaseUrl: "", supabaseKey: "", contactEnabled: false };').toString('base64'),
  });
  await command('Fetch.enable', { patterns: [{ urlPattern: '*/js/config.js' }] });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go('');
  await waitFor('document.querySelectorAll(".photo-card").length === 6');
  await evaluate('document.fonts.ready');
  await evaluate('document.querySelectorAll("img").forEach(img => img.loading = "eager")');
  await waitFor('Array.from(document.images).every(img => !img.getAttribute("src") || (img.complete && img.naturalWidth > 0))');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'desktop overflow');
  await screenshot('desktop.png');
  const galleryGeometry = await evaluate(`Array.from(document.querySelectorAll('.photo-frame')).map(el => { const r=el.getBoundingClientRect(); return {top:r.top,height:r.height,width:r.width}; })`);
  for (let i = 1; i < 3; i++) assert.ok(Math.abs(galleryGeometry[i].top - galleryGeometry[0].top) < 1, 'desktop photos aligned');
  for (const frame of galleryGeometry) assert.ok(Math.abs(frame.height / frame.width - 1.25) < .01, 'consistent photo format');
  await evaluate('document.querySelector("#portfolio").scrollIntoView({behavior:"instant"})');
  await screenshot('portfolio-desktop.png');
  await evaluate('document.querySelector("#about").scrollIntoView({behavior:"instant"})');
  await screenshot('about-desktop.png');
  await evaluate('scrollTo({top:0,behavior:"instant"})');
  await evaluate('document.querySelector("[data-filter=family]").click()');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 4);
  await evaluate('document.querySelector("[data-filter=weddings]").click()');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 0);
  await evaluate('document.querySelector("[data-filter=all]").click(); document.querySelector(".photo-card button").click()');
  assert.equal(await evaluate('document.querySelector("#lightbox").open'), true);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  assert.ok((await evaluate('document.querySelector("#lightbox-caption").textContent')).includes('2 / 6'));
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate('document.querySelector("#lightbox").open'), false);
  assert.equal(await evaluate('document.querySelector("#contact-submit").disabled'), true);
  console.log('PASS desktop gallery, filtering, empty state, lightbox keyboard, disabled unconfigured contact');

  for (const width of [390, 320, 768]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 700 });
    await evaluate('scrollTo(0,0)'); await delay(300);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `overflow at ${width}`);
    if (width === 390) {
      await screenshot('mobile.png');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#gallery")).gridTemplateColumns.split(" ").length'), 2);
      assert.ok(await evaluate('Math.abs(document.querySelectorAll(".photo-frame")[0].getBoundingClientRect().top-document.querySelectorAll(".photo-frame")[1].getBoundingClientRect().top)<1'));
      await evaluate('document.querySelector("#portfolio").scrollIntoView({behavior:"instant"})');
      await screenshot('portfolio-mobile.png');
      await evaluate('scrollTo({top:0,behavior:"instant"})');
      await evaluate('document.querySelector("#menu-toggle").click()');
      assert.equal(await evaluate('document.querySelector("#menu-toggle").getAttribute("aria-expanded")'), 'true');
      await evaluate('document.querySelector("#navigation a").click()');
      assert.equal(await evaluate('document.querySelector("#menu-toggle").getAttribute("aria-expanded")'), 'false');
    }
  }
  console.log('PASS responsive widths 320/390/768 and mobile navigation');
  await go('admin/');
  assert.equal(await evaluate('document.querySelector("#setup").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#login-form button").disabled'), true);
  console.log('PASS admin setup guard without credentials');

  // Mock the transport, not DOM logic. These tests do NOT prove real Supabase RLS.
  let rows = structuredClone(initialPhotos);
  let owner = false;
  let failGallery = false;
  let uploads = 0;
  let removals = 0;
  let contactRequests = 0;
  let refreshRequests = 0;
  const userId = '11111111-1111-4111-8111-111111111111';
  const responseHeaders = [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }];
  async function fulfill(requestId, data, code = 200, type = 'application/json') {
    await command('Fetch.fulfillRequest', { requestId, responseCode: code, responseHeaders: responseHeaders.map((header) => header.name === 'Content-Type' ? { ...header, value: type } : header), body: Buffer.from(type.includes('javascript') ? data : JSON.stringify(data)).toString('base64') });
  }
  intercept = async ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/js/config.js') return fulfill(requestId, 'export const config = { supabaseUrl: "https://test.supabase.co", supabaseKey: "sb_publishable_test", contactEnabled: true };', 200, 'text/javascript');
    if (url.hostname !== 'test.supabase.co') return command('Fetch.continueRequest', { requestId });
    if (request.method === 'OPTIONS') return command('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [...responseHeaders, { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }] });
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') refreshRequests++;
      return fulfill(requestId, { access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 });
    }
    if (url.pathname === '/auth/v1/user') {
      if (request.method === 'PUT') assert.equal(JSON.parse(request.postData).password, 'new-test-password-2026');
      return fulfill(requestId, { id: userId, email: 'owner@example.com' });
    }
    if (url.pathname === '/auth/v1/logout') return fulfill(requestId, {});
    if (url.pathname.endsWith('/is_portfolio_admin')) return fulfill(requestId, owner);
    if (url.pathname === '/rest/v1/photos') {
      if (request.method === 'GET') return failGallery ? fulfill(requestId, {}, 503) : fulfill(requestId, rows.filter((row) => !url.searchParams.has('published') || row.published));
      const id = url.searchParams.get('id')?.replace('eq.', '');
      if (request.method === 'POST') { const row = { ...JSON.parse(request.postData), id: '22222222-2222-4222-8222-222222222222' }; rows.push(row); return fulfill(requestId, [row], 201); }
      if (request.method === 'PATCH') { const row = rows.find((item) => item.id === id); Object.assign(row, JSON.parse(request.postData)); return fulfill(requestId, [row]); }
      if (request.method === 'DELETE') { const deleted = rows.filter((row) => row.id === id); rows = rows.filter((row) => row.id !== id); return fulfill(requestId, deleted); }
    }
    if (url.pathname.startsWith('/storage/v1/object/public/')) {
      const { readFile } = await import('node:fs/promises');
      return command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/webp' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: (await readFile(path.join(root, 'images/hero-bg.webp'))).toString('base64') });
    }
    if (url.pathname.startsWith('/storage/v1/object/portfolio')) { if (request.method === 'POST') uploads++; if (request.method === 'DELETE') removals++; return fulfill(requestId, {}); }
    if (url.pathname === '/functions/v1/contact') { contactRequests++; return fulfill(requestId, { ok: true }); }
    return fulfill(requestId, {}, 404);
  };
  await command('Fetch.enable', { patterns: [{ urlPattern: '*config.js' }, { urlPattern: 'https://test.supabase.co/*' }] });
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go('admin/');
  async function submitLogin() { await evaluate('document.querySelector("[name=email]").value="owner@example.com"; document.querySelector("[name=password]").value="test-password"; document.querySelector("#login-form").requestSubmit()'); }
  await submitLogin();
  await waitFor('document.querySelector("#admin-status").textContent.includes("не назначен")');
  assert.equal(await evaluate('document.querySelector("#workspace").hidden'), true);
  owner = true; await submitLogin();
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 6');
  await screenshot('admin.png');
  await evaluate(`document.querySelector('.account-settings').open=true;
    document.querySelector('[name=current_password]').value='test-password';
    document.querySelector('[name=new_password]').value='new-test-password-2026';
    document.querySelector('[name=confirm_password]').value='not-matching-password';
    document.querySelector('#password-form').requestSubmit()`);
  await waitFor('document.querySelector("#password-status").textContent.includes("не совпадают")');
  await evaluate(`document.querySelector('[name=confirm_password]').value='new-test-password-2026'; document.querySelector('#password-form').requestSubmit()`);
  await waitFor('document.querySelector("#password-status").textContent.includes("Пароль изменён")');
  assert.equal(await evaluate('document.querySelector("[name=new_password]").value'), '');
  console.log('PASS password change form, mismatch and cleared fields');
  await evaluate('const s=JSON.parse(sessionStorage.getItem("zuka-admin-session")); s.expires_at=1; sessionStorage.setItem("zuka-admin-session", JSON.stringify(s))');
  await go('admin/');
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 6');
  assert.equal(refreshRequests, 1, 'expired session must refresh');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'admin mobile overflow');
  await screenshot('admin-mobile.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("#photo-library [name=title]").value="<img src=x onerror=alert(1)>"; document.querySelector("#photo-library form").requestSubmit()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("Изменения сохранены")');
  assert.equal(rows[0].title, '<img src=x onerror=alert(1)>');
  await evaluate('document.querySelector("#tab-upload").click()');
  const documentNode = await command('DOM.getDocument');
  const inputNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' });
  await command('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [path.join(root, 'images/hero-bg.webp')] });
  await waitFor('document.querySelectorAll("#upload-queue .editor-card").length === 1 && !document.querySelector("#upload-submit").disabled');
  await evaluate('document.querySelector("#upload-form").requestSubmit()');
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 7');
  assert.equal(uploads, 1); assert.equal(rows.at(-1).published, false); assert.equal(rows.at(-1).source, 'storage');
  await evaluate('document.querySelectorAll("#photo-library .editor-actions button:last-child")[6].click(); document.querySelector("#cancel-delete").click()');
  assert.equal(rows.length, 7);
  await evaluate('document.querySelectorAll("#photo-library .editor-actions button:last-child")[6].click(); document.querySelector("#confirm-delete").click()');
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 6');
  assert.equal(removals, 1);
  await evaluate('document.querySelector("#logout").click()');
  await waitFor('document.querySelector("#workspace").hidden');
  assert.equal(await evaluate('sessionStorage.getItem("zuka-admin-session")'), null);
  console.log('PASS mocked non-owner denial, owner login, metadata save, WebP processing/upload, draft, delete cancel/confirm, logout');

  await go('');
  await waitFor('document.querySelectorAll(".photo-card").length === 6');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card img").length'), 6, 'no HTML injection');
  await evaluate('document.querySelector("#contact-form [name=name]").value="Test"; document.querySelector("#contact-form [name=contact]").value="test@example.com"; document.querySelector("#contact-form").requestSubmit()');
  await waitFor('document.querySelector("#contact-status").textContent.includes("გმადლობთ")');
  assert.equal(contactRequests, 1);
  failGallery = true;
  await go(''); await waitFor('!document.querySelector("#gallery-retry").hidden');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 0, 'must not resurrect local photos on backend failure');
  failGallery = false; rows = [];
  await evaluate('document.querySelector("#gallery-retry").click()');
  await waitFor('document.querySelector("#gallery-retry").hidden');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 0);
  console.log('PASS mocked contact, backend failure retry and authoritative empty database');
  if (process.argv.includes('--live')) {
    await command('Fetch.disable');
    intercept = null;
    await go('');
    await waitFor('document.querySelectorAll(".photo-card").length === 6');
    assert.equal(await evaluate('document.querySelector("#gallery-retry").hidden'), true);
    await screenshot('live-gallery.png');
    await go('admin/');
    assert.equal(await evaluate('document.querySelector("#setup").hidden'), true);
    assert.equal(await evaluate('document.querySelector("#login-form button").disabled'), false);
    console.log('PASS live Supabase gallery and configured admin login screen (no owner login)');
  }
  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('ALL BROWSER TESTS PASSED');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close', {}, null); } catch {} socket.close(); }
  chrome.kill(); server.kill();
  await delay(600); await rm(profile, { recursive: true, force: true }).catch(() => {});
}