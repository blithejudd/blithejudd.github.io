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
let originalRows, ownedRows, demoToken;
const base = 'http://127.0.0.1:4173';
async function demoRows() { const response = await fetch(base + '/preview-api/rest/v1/site_content', {headers:{Authorization: 'Bearer ' + demoToken}}); assert.equal(response.status,200); return response.json(); }
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
  const configSource = await (await fetch(base + '/js/config.js')).text();
  assert.ok(configSource.includes('"preview":true'), 'must use isolated local demo');
  const auth = await fetch(base + '/preview-api/auth/v1/token?grant_type=password', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'demo@example.com',password:'demo-password'})});
  demoToken = (await auth.json()).access_token;
  originalRows = await demoRows(); ownedRows = structuredClone(originalRows);
  await command('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await go('admin/#contact');
  await evaluate('document.querySelector("#login-form").requestSubmit()');
  await waitFor('!document.querySelector("#workspace").hidden && !document.querySelector("#content-save").disabled && document.querySelector("#cms-footer-phone")');
  assert.equal(await evaluate('document.querySelector("#content-title").textContent'), 'კონტაქტები');
  assert.equal(await evaluate('document.querySelector("[data-section=contact] .editor-group input").name'), 'footer.phone');
  assert.equal(await evaluate('document.querySelector("#cms-c104-text0").closest("[data-section]").dataset.section'), 'advanced');
  await screenshot('admin-contacts-desktop.png');
  for (const width of [768,390,320]) {
    await command('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width<600});
    await evaluate('window.scrollTo(0,0)');
    await evaluate(`{ const navigation=document.querySelector('#admin-navigation'); navigation.value='about'; navigation.dispatchEvent(new Event('change',{bubbles:true})); navigation.value='contact'; navigation.dispatchEvent(new Event('change',{bubbles:true})); }`);
    assert.equal(await evaluate('document.querySelector("#tab-contact").getAttribute("aria-pressed")'),'true');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true, `overflow at ${width}`);
    await screenshot(`admin-contacts-${width}.png`);
  }
  await command('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  for(const [tab,page] of [['content','hero'],['about','about'],['services','services'],['portfolio','portfolio'],['advanced','advanced']]) {
    await evaluate(`document.querySelector('#tab-${tab}').click(); window.scrollTo(0,0)`);
    assert.equal(await evaluate(`!document.querySelector('[data-section=${page}]').hidden`),true);
    assert.equal(await evaluate('document.querySelectorAll(".editor-page:not([hidden])").length'),1);
    assert.doesNotMatch(await evaluate('document.querySelector("#content-panel").innerText'), /[А-Яа-яЁё]/);
    await screenshot(`admin-editor-${page}.png`);
  }
  // DOM nodes and staged values survive page switches; save/publish use the actual demo backend.
  await evaluate(`document.querySelector('#tab-contact').click(); const field=document.querySelector('[name="c098.href"]'); field.value='https://evil.example/profile'; field.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#content-save').click()`);
  await waitFor('document.querySelector("#admin-status").classList.contains("error")');
  assert.deepEqual(await demoRows(),originalRows,'invalid Instagram must not write a draft');
  assert.equal(await evaluate('document.querySelector("#cms-c098-href").validity.customError'),true);
  assert.doesNotMatch(await evaluate('document.querySelector("#cms-c098-href").validationMessage'), /[А-Яа-яЁё]/);
  await evaluate(`document.querySelector('#tab-contact').click(); const phone=document.querySelector('[name="footer.phone"]'); phone.value='+995 (555) 00-01-23'; phone.dispatchEvent(new Event('input',{bubbles:true})); const instagram=document.querySelector('[name="c098.href"]'); instagram.value='@editor_check'; instagram.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#tab-about').click(); document.querySelector('#tab-contact').click()`);
  assert.equal(await evaluate('document.querySelector("#cms-footer-phone").value'),'+995 (555) 00-01-23');
  assert.equal(await evaluate('document.querySelector("#content-form").dataset.dirty'),'true');
  await evaluate('document.querySelector("#content-save").click()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("მონახაზი შენახულია")');
  ownedRows = await demoRows();
  assert.equal(ownedRows.find(row=>row.id==='draft').values['footer.phone'],'+995555000123');
  assert.equal(ownedRows.find(row=>row.id==='draft').values['c098.href'],'https://instagram.com/editor_check');
  assert.deepEqual(ownedRows.find(row=>row.id==='published'), originalRows.find(row=>row.id==='published'));
  await evaluate('document.querySelector("#content-preview").click()');
  await waitFor('document.querySelector("#content-preview-dialog iframe").contentDocument?.querySelector("#footer-phone")?.getAttribute("href") === "tel:+995555000123"');
  ownedRows = await demoRows();
  assert.equal(await evaluate('document.querySelector("#content-preview-dialog iframe").contentDocument.querySelector("[data-account]").textContent'),'@editor_check');
  await evaluate('document.querySelector("#close-content-preview").click(); document.querySelector("#content-publish").click()');
  await waitFor('Boolean(document.querySelector("dialog[open]"))');
  await evaluate('document.querySelector("dialog[open] button:last-child").click()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("შინაარსი გამოქვეყნებულია")');
  ownedRows = await demoRows();
  await go('');
  await waitFor('document.querySelector("#footer-phone").getAttribute("href") === "tel:+995555000123"');
  assert.equal(await evaluate('document.querySelector("#footer-phone").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#footer-contacts [data-instagram]").href'),'https://instagram.com/editor_check');
  await evaluate('document.querySelector("#footer-contacts").scrollIntoView({behavior:"instant"})');
  await screenshot('admin-published-contacts-check.png');
  await go('admin/');
  await waitFor('!document.querySelector("#workspace").hidden && !document.querySelector("#content-save").disabled');
  await evaluate(`document.querySelector('#tab-contact').click(); document.querySelector('[name="footer.phone"]').value=''; document.querySelector('[name="c098.href"]').value=''; document.querySelector('#content-publish').click()`);
  await waitFor('Boolean(document.querySelector("dialog[open]"))');
  await evaluate('document.querySelector("dialog[open] button:last-child").click()');
  await waitFor('document.querySelector("#admin-status").textContent.includes("შინაარსი გამოქვეყნებულია")');
  ownedRows = await demoRows();
  await go('');
  await waitFor('document.querySelector("#footer-contacts").hidden');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("[data-instagram]")).every(link=>link.hidden && !link.hasAttribute("href"))'),true);
  await go('admin/');
  await waitFor('!document.querySelector("#workspace").hidden && !document.querySelector("#content-save").disabled');
  for(const tab of ['photos','categories','connections']) {
    await evaluate(`document.querySelector('#tab-${tab}').click(); window.scrollTo(0,0)`);
    assert.equal(await evaluate(`document.querySelector('#${tab}-panel').hidden`),false);
    await screenshot(`admin-editor-${tab}.png`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS actual demo: navigation, 320/390/768/1440 layout, unsaved page switching, draft isolation, preview, publish, public tel/Instagram and empty hiding');
} finally {
  try {
    if(originalRows) {
      const current = await demoRows();
      for(const original of originalRows) {
        const row=current.find(item=>item.id===original.id), owned=ownedRows.find(item=>item.id===original.id);
        assert.equal(row.revision,owned.revision,'concurrent edit detected: do not overwrite user changes');
        if(JSON.stringify(row.values)===JSON.stringify(original.values)) continue;
        const response=await fetch(`${base}/preview-api/rest/v1/site_content?id=eq.${row.id}&revision=eq.${row.revision}`, {method:'PATCH',headers:{Authorization:'Bearer '+demoToken,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({values:original.values,revision:row.revision+1})});
        assert.equal(response.status,200,'restore original demo content');
      }
      const restored=await demoRows();
      for(const original of originalRows) assert.deepEqual(restored.find(row=>row.id===original.id).values,original.values);
      console.log('PASS original draft and published content restored; no test contact data left');
    }
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close', {}, null); } catch {} socket.close(); }
    chrome.kill(); await delay(600); await rm(profile, {recursive:true,force:true}).catch(()=>{});
  }
}
