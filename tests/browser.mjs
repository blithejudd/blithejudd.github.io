// Browser integration tests without npm dependencies. Uses installed Chromium via CDP.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initialPhotos, initialCategories } from '../js/data.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'zuka-browser-'));
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs')], { stdio: 'ignore' });
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--lang=ru-RU', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
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
  await command('Emulation.setLocaleOverride', { locale: 'ru_RU' });
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
  assert.equal(await evaluate('document.documentElement.lang'), 'ka');
  assert.equal(await evaluate('document.querySelector("[name=date]").type'), 'text');
  assert.equal(await evaluate('document.querySelector("[name=date]").placeholder'), 'დღე.თვე.წელი');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /[А-Яа-яЁё]/);
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
      await evaluate('document.querySelector("#contact-form").scrollIntoView({behavior:"instant"})');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Georgian date hint fits mobile');
      await screenshot('contact-mobile.png');
      await evaluate('scrollTo({top:0,behavior:"instant"})');
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
  let categoryRows = structuredClone(initialCategories);
  let contentRows = ['draft', 'published'].map((id) => ({ id, values: {}, revision: 0 }));
  let owner = false;
  let failGallery = false;
  let failContent = false;
  let uploads = 0;
  let removals = 0;
  let contactRequests = 0;
  let contactPayload;
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
    if (url.pathname === '/rest/v1/categories') {
      const id = url.searchParams.get('id')?.replace('eq.', '');
      if (request.method === 'GET') return fulfill(requestId, categoryRows.filter((row) => request.headers.Authorization === 'Bearer test-token' || row.visible));
      if (request.method === 'POST') { const row = JSON.parse(request.postData); categoryRows.push(row); return fulfill(requestId, [row]); }
      if (request.method === 'PATCH') { const row = categoryRows.find((item) => item.id === id); Object.assign(row, JSON.parse(request.postData)); return fulfill(requestId, [row]); }
      if (request.method === 'DELETE') {
        if (rows.some((row) => row.category === id)) return fulfill(requestId, {}, 409);
        const removed = categoryRows.filter((row) => row.id === id); categoryRows = categoryRows.filter((row) => row.id !== id); return fulfill(requestId, removed);
      }
    }
    if (url.pathname === '/rest/v1/site_content') {
      if (failContent) return fulfill(requestId, {}, 503);
      const id = url.searchParams.get('id')?.replace('eq.', '');
      if (request.method === 'GET') return fulfill(requestId, contentRows.filter((row) => !id || row.id === id));
      const row = contentRows.find((row) => row.id === id);
      if (Number(url.searchParams.get('revision')?.replace('eq.', '')) !== row.revision) return fulfill(requestId, []);
      Object.assign(row, JSON.parse(request.postData)); return fulfill(requestId, [row]);
    }
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
    if (url.pathname === '/functions/v1/contact') { contactRequests++; contactPayload = JSON.parse(request.postData); return fulfill(requestId, { ok: true }); }
    return fulfill(requestId, {}, 404);
  };
  await command('Fetch.enable', { patterns: [{ urlPattern: '*config.js' }, { urlPattern: 'https://test.supabase.co/*' }] });
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go('admin/');
  assert.equal(await evaluate('document.documentElement.lang'), 'ka');
  await evaluate('document.querySelector("#login-form").requestSubmit()');
  assert.equal(await evaluate('document.querySelector("[name=email]").validationMessage'), 'გთხოვთ, შეავსოთ ეს ველი.');
  await evaluate('document.querySelector("[name=email]").value="invalid"; document.querySelector("[name=email]").dispatchEvent(new Event("input", {bubbles:true}))');
  assert.equal(await evaluate('document.querySelector("[name=email]").validationMessage'), 'შეიყვანეთ სწორი ელფოსტის მისამართი.');
  await screenshot('admin-login.png');
  async function submitLogin() { await evaluate('document.querySelector("[name=email]").value="owner@example.com"; document.querySelector("[name=password]").value="test-password"; document.querySelectorAll("#login-form input").forEach(input => input.dispatchEvent(new Event("input", {bubbles:true}))); document.querySelector("#login-form").requestSubmit()'); }
  await submitLogin();
  await waitFor('document.querySelector("#admin-status").textContent.includes("არ არის დანიშნული")');
  assert.equal(await evaluate('document.querySelector("#workspace").hidden'), true);
  owner = true; await submitLogin();
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 6');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /[А-Яа-яЁё]/);
  await screenshot('admin.png');
  await evaluate(`document.querySelector('.account-settings').open=true;
    document.querySelector('[name=current_password]').value='test-password';
    document.querySelector('[name=new_password]').value='new-test-password-2026';
    document.querySelector('[name=confirm_password]').value='not-matching-password';
    document.querySelector('#password-form').requestSubmit()`);
  await waitFor('document.querySelector("#password-status").textContent.includes("არ ემთხვევა")');
  await evaluate(`document.querySelector('[name=confirm_password]').value='new-test-password-2026'; document.querySelector('#password-form').requestSubmit()`);
  await waitFor('document.querySelector("#password-status").textContent.includes("პაროლი შეცვლილია")');
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
  await evaluate(`window.unsavedCard = document.querySelectorAll('#photo-library .editor-card')[1];
    unsavedCard.querySelector('[name=title]').value = 'Unsaved title';
    unsavedCard.querySelector('[name=alt]').value = '';
    unsavedCard.querySelector('[name=category]').value = 'weddings';
    unsavedCard.querySelector('[name=sort_order]').value = '';
    unsavedCard.querySelector('[name=published]').checked = false`);
  async function assertUnsavedCard(action) {
    assert.equal(await evaluate(`unsavedCard.isConnected &&
      unsavedCard.querySelector('[name=title]').value === 'Unsaved title' &&
      unsavedCard.querySelector('[name=alt]').value === '' &&
      unsavedCard.querySelector('[name=category]').value === 'weddings' &&
      unsavedCard.querySelector('[name=sort_order]').value === '' &&
      !unsavedCard.querySelector('[name=published]').checked`), true, `unsaved edits survive ${action}`);
    assert.equal(rows[1].title, initialPhotos[1].title, 'draft must not be saved implicitly');
  }
  await evaluate('document.querySelector("#photo-library [name=title]").value="<img src=x onerror=alert(1)>"; document.querySelector("#photo-library form").requestSubmit()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("ცვლილებები შენახულია")');
  assert.equal(rows[0].title, '<img src=x onerror=alert(1)>');
  await assertUnsavedCard('saving another photo');
  await evaluate('document.querySelector("#tab-upload").click()');
  const documentNode = await command('DOM.getDocument');
  const inputNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' });
  await command('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [path.join(root, 'images/hero-bg.webp')] });
  await waitFor('document.querySelectorAll("#upload-queue .editor-card").length === 1 && !document.querySelector("#upload-submit").disabled');
  await evaluate('document.querySelector("#upload-form").requestSubmit()');
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 7');
  assert.equal(uploads, 1); assert.equal(rows.at(-1).published, false); assert.equal(rows.at(-1).source, 'storage');
  await assertUnsavedCard('uploading a photo');
  await evaluate('document.querySelectorAll("#photo-library .editor-actions button:last-child")[6].click(); document.querySelector("#cancel-delete").click()');
  assert.equal(rows.length, 7);
  await evaluate('document.querySelectorAll("#photo-library .editor-actions button:last-child")[6].click(); document.querySelector("#confirm-delete").click()');
  await waitFor('document.querySelectorAll("#photo-library .editor-card").length === 6');
  assert.equal(removals, 1);
  await assertUnsavedCard('deleting another photo');
  console.log('PASS unsaved fields survive save, upload and delete without implicit persistence');
  await evaluate('document.querySelector("#tab-categories").click()');
  await waitFor('document.querySelectorAll(".category-card").length === 4');
  await evaluate(`document.querySelector('#category-create [name=name]').value='არქიტექტურა'; document.querySelector('#category-create').requestSubmit()`);
  await waitFor('document.querySelectorAll(".category-card").length === 5');
  const newCategory = categoryRows.at(-1).id;
  await evaluate(`const card=document.querySelectorAll('.category-card')[4]; card.querySelector('[name=name]').value='არქიტექტურა და სივრცე'; card.querySelector('[name=sort_order]').value=5; card.requestSubmit()`);
  await waitFor('document.querySelector("#admin-status").textContent.includes("კატეგორია შენახულია")');
  assert.equal(categoryRows.at(-1).name, 'არქიტექტურა და სივრცე');
  await screenshot('cms-categories.png');
  await evaluate(`document.querySelector('#tab-photos').click(); document.querySelector('#photo-library select[name=category]').value=${JSON.stringify(newCategory)}; document.querySelector('#photo-library form').requestSubmit()`);
  await waitFor('document.querySelector("#admin-status").textContent.includes("ცვლილებები შენახულია")');
  assert.equal(rows[0].category, newCategory);
  const replacementNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#photo-library .file-picker input' });
  await command('DOM.setFileInputFiles', { nodeId: replacementNode.nodeId, files: [path.join(root, 'images/portfolio-2.webp')] });
  await evaluate('document.querySelector("#photo-library form").requestSubmit()');
  await waitFor('document.querySelector("#photo-library .file-info").textContent.includes("Supabase")');
  assert.equal(rows[0].source, 'storage', 'portfolio photo replacement');
  await assertUnsavedCard('category and photo changes');
  await evaluate('document.querySelector("#tab-content").click()');
  await waitFor('document.querySelectorAll("#content-form [name]").length > 50');
  const heroKey = await evaluate(`const field=Array.from(document.querySelectorAll('#content-form textarea')).find(input=>input.value.includes('მე ზუკა ვარ')); field.value='ახალი მთავარი აღწერა'; field.dispatchEvent(new Event('input',{bubbles:true})); field.name`);
  const linkKey = await evaluate(`const linkField=document.querySelector('#content-form [name="c098.href"]'); linkField.value='@new_portfolio'; document.querySelector('#content-form [name="footer.phone"]').value='+995 (555) 12-34-56'; linkField.name`);
  await evaluate(`document.querySelector('#content-form [name="services.visible"]').checked=false; document.querySelector('#content-form [name="about.order"]').value=5; document.querySelector('#content-form [name="portfolio.order"]').value=20`);
  const heroImageNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#content-form [data-section=hero] input[type=file]' });
  await command('DOM.setFileInputFiles', { nodeId: heroImageNode.nodeId, files: [path.join(root, 'images/portfolio-1.webp')] });
  await screenshot('cms-content.png');
  await evaluate('document.querySelector("#content-save").click()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("მონახაზი შენახულია")');
  assert.equal(contentRows[0].values[heroKey], 'ახალი მთავარი აღწერა');
  assert.deepEqual(contentRows[1].values, {}, 'draft must remain unpublished');
  assert.equal(contentRows[0].values[linkKey], 'https://instagram.com/new_portfolio');
  assert.equal(contentRows[0].values['footer.phone'], '+995555123456');
  assert.equal(contentRows[0].values['services.visible'], false);
  await evaluate('document.querySelector("#content-preview").click()');
  await waitFor('document.querySelector("#content-preview-dialog").open && document.querySelector("#content-preview-dialog iframe").contentDocument?.body.innerText.includes("ახალი მთავარი აღწერა")');
  assert.equal(await evaluate('document.querySelector("#content-preview-dialog iframe").contentDocument.querySelector("#services").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#content-preview-dialog iframe").contentDocument.querySelector("#footer-phone").getAttribute("href")'), 'tel:+995555123456');
  assert.equal(await evaluate('Array.from(document.querySelector("#content-preview-dialog iframe").contentDocument.querySelectorAll("[data-instagram]")).every(link=>link.href==="https://instagram.com/new_portfolio")'), true);
  await evaluate('document.querySelector("#close-content-preview").click(); document.querySelector("#content-publish").click()');
  await waitFor('Boolean(document.querySelector("dialog[open]"))');
  await evaluate('document.querySelector("dialog[open] button:last-child").click()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("შინაარსი გამოქვეყნებულია")');
  assert.equal(contentRows[1].values[heroKey], 'ახალი მთავარი აღწერა');
  assert.equal(contentRows[1].values['footer.phone'], '+995555123456');
  await evaluate(`document.querySelector('#content-form').elements.namedItem(${JSON.stringify(heroKey)}).value='დროებითი მონახაზი'; document.querySelector('#content-save').click()`);
  await waitFor('document.querySelector("#admin-status").textContent.includes("მონახაზი შენახულია")');
  assert.equal(contentRows[0].values[heroKey], 'დროებითი მონახაზი');
  await evaluate('document.querySelector("#content-revert").click()');
  await waitFor('Boolean(document.querySelector("dialog[open]"))');
  await evaluate('document.querySelector("dialog[open] button:last-child").click()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("მონახაზი აღდგენილია")');
  assert.equal(contentRows[0].values[heroKey], 'ახალი მთავარი აღწერა');
  console.log('PASS editable content, image replacement, draft preview/publication, dynamic category and preserved sibling edits');
  await evaluate('document.querySelector("#tab-upload").click()');
  await command('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: Array(13).fill(path.join(root, 'images/hero-bg.webp')) });
  await waitFor('document.querySelectorAll("#upload-queue .editor-card").length === 13 && !document.querySelector("#upload-submit").disabled');
  await evaluate('document.querySelector("#clear-queue").click()');
  assert.equal(await evaluate('document.querySelectorAll("#upload-queue .editor-card").length'), 0);
  console.log('PASS photo queue accepts more than twelve files');
  await command('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [path.join(root, 'images/hero-bg.webp')] });
  await waitFor('document.querySelectorAll("#upload-queue .editor-card").length === 1 && !document.querySelector("#upload-submit").disabled');
  await screenshot('admin-upload.png');
  await evaluate('document.querySelector("#logout").click()');
  assert.equal(await evaluate('document.querySelector("#logout-dialog").open'), true);
  await evaluate('document.querySelector("#cancel-logout").click()');
  assert.equal(await evaluate('document.querySelectorAll("#upload-queue .editor-card").length'), 1);
  await evaluate('document.querySelector("#logout").click(); document.querySelector("#confirm-logout").click()');
  await waitFor('document.querySelector("#workspace").hidden');
  assert.equal(await evaluate('sessionStorage.getItem("zuka-admin-session")'), null);
  console.log('PASS mocked non-owner denial, owner login, metadata save, WebP processing/upload, draft, delete cancel/confirm, logout');

  await go('');
  await waitFor('document.querySelector("#footer-phone").getAttribute("href") === "tel:+995555123456"');
  assert.equal(await evaluate('document.querySelector("#footer-phone").hidden'), false);
  await evaluate('document.querySelector("#footer-contacts").scrollIntoView()');
  await screenshot('footer-contacts-desktop.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('document.querySelector("#footer-contacts").scrollIntoView()');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await screenshot('footer-contacts-mobile.png');
  await evaluate(`import('/js/content.js').then(({applyContent}) => applyContent(document, {'footer.phone':'', 'c098.href':''}))`);
  assert.equal(await evaluate('document.querySelector("#footer-contacts").hidden && Array.from(document.querySelectorAll("[data-instagram]")).every(link=>link.hidden && !link.hasAttribute("href"))'), true);
  await evaluate(`import('/js/content.js').then(({applyContent}) => applyContent(document, {'footer.phone':'+995555123456', 'c098.href':'@new_portfolio'}))`);
  assert.equal(await evaluate('!document.querySelector("#footer-contacts").hidden && document.querySelector("#footer-phone").href === "tel:+995555123456"'), true);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  console.log('PASS public contact publication, normalized links, empty hiding and responsive footer');
  await waitFor('document.querySelectorAll(".photo-card").length === 6');
  await waitFor('document.body.innerText.includes("ახალი მთავარი აღწერა")');
  assert.equal(await evaluate('document.querySelector("#services").hidden'), true);
  assert.equal(await evaluate('document.querySelector(".hero-image img").hasAttribute("srcset")'), false);
  assert.equal(await evaluate('document.querySelector("#contact-form [name=category]").querySelectorAll("option").length'), 5);
  await evaluate(`document.querySelector('[data-filter="${newCategory}"]').click()`);
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 1);
  await evaluate('document.querySelector("[data-filter=all]").click()');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card img").length'), 6, 'no HTML injection');
  await evaluate('document.querySelector("#contact").scrollIntoView({behavior:"instant"})');
  await screenshot('contact-desktop.png');
  await evaluate('document.querySelector("#contact-form [name=name]").value="Test"; document.querySelector("#contact-form [name=contact]").value="test@example.com"; document.querySelector("[name=date]").value="31.02.2026"; document.querySelector("#contact-form").requestSubmit()');
  assert.equal(contactRequests, 0, 'impossible date must not be sent');
  assert.equal(await evaluate('document.querySelector("[name=date]").validationMessage'), 'შეიყვანეთ არსებული კალენდარული თარიღი.');
  await evaluate('document.querySelector("[name=date]").value="25.12.2026"; document.querySelector("[name=date]").dispatchEvent(new Event("input", {bubbles:true})); document.querySelector("#contact-form").requestSubmit()');
  await waitFor('document.querySelector("#contact-status").textContent.includes("გმადლობთ")');
  assert.equal(contactRequests, 1);
  assert.equal(contactPayload.date, '2026-12-25');
  console.log('PASS Georgian UI/validation, date conversion and logout dialog under Russian locale');
  failGallery = true;
  await go(''); await waitFor('!document.querySelector("#gallery-retry").hidden');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 0, 'must not resurrect local photos on backend failure');
  failGallery = false; rows = [];
  await evaluate('document.querySelector("#gallery-retry").click()');
  await waitFor('document.querySelector("#gallery-retry").hidden');
  assert.equal(await evaluate('document.querySelectorAll(".photo-card").length'), 0);
  console.log('PASS mocked contact, backend failure retry and authoritative empty database');
  failContent = true; await go('');
  await waitFor('document.querySelector("main").hidden && document.body.innerText.includes("შინაარსი დროებით მიუწვდომელია")');
  failContent = false;
  console.log('PASS content outage does not resurrect hidden static sections');
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
  if (process.argv.includes('--demo')) {
    await command('Fetch.disable'); intercept = null;
    await go('admin/');
    assert.equal(await evaluate('document.querySelector("#preview-notice").hidden'), false);
    await evaluate('document.querySelector("#login-form").requestSubmit()');
    await waitFor('document.querySelectorAll("#content-form [name]").length > 50');
    await evaluate('document.querySelector("#tab-content").click()');
    await screenshot('cms-demo-desktop.png');
    await evaluate('document.querySelector("#content-form [data-section=hero]").scrollIntoView({behavior:"instant"})');
    await screenshot('cms-fields-desktop.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'CMS mobile overflow');
    await screenshot('cms-demo-mobile.png');
    await evaluate('document.querySelector("#content-form [data-section=hero]").scrollIntoView({behavior:"instant"})');
    await screenshot('cms-fields-mobile.png');
    console.log('PASS actual local CMS demo login and responsive content editor');
    await evaluate('document.querySelector("#tab-connections").click()');
    await waitFor('!document.querySelector("#connections-notice").hidden === false');
    assert.doesNotMatch(await evaluate('document.querySelector("#connections-panel").innerText'), /[А-Яа-яЁё]/);
    await evaluate(`document.querySelector('#telegram-settings [name=bot_token]').value='demo-bot-token'; document.querySelector('#telegram-settings [name=chat_id]').value='demo-chat-id'; document.querySelector('#telegram-settings [name=enabled]').checked=true; document.querySelector('#telegram-settings').requestSubmit()`);
    await waitFor('document.querySelector("#admin-status").textContent.includes("პარამეტრები შენახულია")');
    assert.equal(await evaluate('document.querySelector("#telegram-settings [name=bot_token]").value'), '');
    assert.equal(await evaluate('document.querySelector("#telegram-settings [name=chat_id]").value'), '');
    assert.equal(await evaluate('JSON.stringify({...localStorage,...sessionStorage}).includes("demo-bot-token")'), false);
    await evaluate('document.querySelector("#telegram-check").click()');
    await waitFor('document.querySelector("#admin-status").textContent.includes("დემო შემოწმება წარმატებულია")');
    await evaluate('document.querySelector("#connections-panel").scrollIntoView({behavior:"instant"})');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'connections mobile overflow');
    await screenshot('connections-mobile.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await screenshot('connections-desktop.png');
    await evaluate(`document.querySelector('#supabase-settings').closest('details').open=true; document.querySelector('#supabase-settings').requestSubmit()`);
    await waitFor('!document.querySelector("#config-download").hidden');
    const stagedConfig = await evaluate('fetch(document.querySelector("#config-download").href).then(r=>r.text())');
    assert.ok(stagedConfig.includes('https://example.supabase.co'));
    assert.equal(stagedConfig.includes('demo-bot-token'), false);
    assert.equal(await evaluate('document.querySelector("#active-supabase-url").textContent'), 'http://127.0.0.1:4173/preview-api');
    await go('');
    await waitFor('!document.querySelector("#contact-submit").disabled');
    await go('admin/');
    await waitFor('!document.querySelector("#workspace").hidden && !document.querySelector("#content-save").disabled');
    await evaluate('document.querySelector("#tab-connections").click(); document.querySelector("#telegram-settings [name=enabled]").checked=false; document.querySelector("#telegram-settings").requestSubmit()');
    await waitFor('document.querySelector("#admin-status").textContent.includes("პარამეტრები შენახულია")');
    await go('');
    await waitFor('document.querySelectorAll(".photo-card").length === 6');
    assert.equal(await evaluate('document.querySelector("#contact-submit").disabled'), true);
    console.log('PASS connection settings persistence, masked secrets, explicit simulated test, staged public config and live enable/disable');
  }
  assert.deepEqual(errors, [], 'uncaught browser errors');
  console.log('ALL BROWSER TESTS PASSED');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close', {}, null); } catch {} socket.close(); }
  chrome.kill(); server.kill();
  await delay(600); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
