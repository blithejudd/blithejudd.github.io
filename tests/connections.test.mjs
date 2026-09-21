import test from 'node:test';
import assert from 'node:assert/strict';
import { createContactHandler, createConnectionsHandler } from '../supabase/functions/_shared/integration-handlers.js';
import { validateTelegram, validatePublicConfig } from '../js/connections-validation.js';
import { readFile } from 'node:fs/promises';

const token = '123456:' + 'x'.repeat(35);
const runtime = { enabled: true, token, chatId: '-1234567', salt: 's'.repeat(40), allowedOrigins: ['https://gulievi.me'] };
const env = (key) => ({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key' })[key];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function transport({ owner = true, validUser = true, enabled = true, quota = true, category = true, providerFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'test-user' }, validUser ? 200 : 401);
    if (url.endsWith('/rpc/is_portfolio_admin')) return json(owner);
    if (url.endsWith('/rpc/contact_runtime')) return json({ ...runtime, enabled });
    if (url.includes('/rest/v1/categories?')) return json(category ? [{ name: 'არქიტექტურა' }] : []);
    if (url.endsWith('/rpc/consume_contact_quota')) return json(quota);
    if (url.startsWith('https://api.telegram.org/')) {
      if (providerFails) throw new Error('Provider failure with sensitive URL ' + url);
      return json({ ok: true, result: { deliberatelySensitive: token } });
    }
    throw new Error('Unexpected request');
  };
  return { calls, fetchImpl };
}
const request = (body, authorization = 'Bearer user-token', origin = 'https://gulievi.me') => new Request('https://edge.example/function', { method: 'POST', headers: { 'Content-Type': 'application/json', origin, ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
const contact = { name: 'ტესტი', contact: 'test@example.com', category: 'architecture', date: '2026-12-25', message: '', website: '' };

test('connection tests require validated owner and never send Telegram messages', async () => {
  for (const options of [{ validUser: false }, { owner: false }]) {
    const mock = transport(options);
    const response = await createConnectionsHandler({ env, fetchImpl: mock.fetchImpl })(request({ action: 'test_telegram' }));
    assert.ok([401, 403].includes(response.status));
    assert.equal(mock.calls.some((call) => call.url.includes('telegram.org') || call.url.endsWith('contact_runtime')), false);
  }
  const mock = transport(); const handler = createConnectionsHandler({ env, fetchImpl: mock.fetchImpl });
  assert.equal((await handler(request({ action: 'test_telegram' }, null))).status, 401);
  assert.equal(mock.calls.length, 0);
  const response = await handler(request({ action: 'test_telegram' }));
  assert.deepEqual(await response.json(), { botValid: true, chatReachable: true });
  assert.deepEqual(mock.calls.filter((call) => call.url.includes('telegram.org')).map((call) => call.url.split('/').at(-1)), ['getMe', 'getChat']);
  assert.equal(mock.calls.some((call) => call.url.endsWith('sendMessage')), false);
});

test('contact validates body before category lookup and respects disable, origin and quota', async () => {
  const good = transport();
  const response = await createContactHandler({ env, fetchImpl: good.fetchImpl })(request(contact, null));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const delivery = good.calls.find((call) => call.url.endsWith('/sendMessage'));
  assert.ok(JSON.parse(delivery.options.body).text.includes('არქიტექტურა'));
  for (const [options, body, origin, expected] of [
    [{ enabled: false }, contact, 'https://gulievi.me', 503],
    [{}, contact, 'https://evil.example', 403],
    [{ quota: false }, contact, 'https://gulievi.me', 429],
    [{ category: false }, contact, 'https://gulievi.me', 400],
    [{}, { ...contact, name: '' }, 'https://gulievi.me', 400],
    [{}, { ...contact, message: 'x'.repeat(17000) }, 'https://gulievi.me', 400],
  ]) {
    const mock = transport(options);
    const result = await createContactHandler({ env, fetchImpl: mock.fetchImpl })(request(body, null, origin));
    assert.equal(result.status, expected);
    assert.equal(mock.calls.some((call) => call.url.includes('telegram.org')), false);
  }
});

test('Edge errors and responses never reflect provider secrets', async () => {
  for (const create of [createContactHandler, createConnectionsHandler]) {
    const mock = transport({ providerFails: true });
    const response = await create({ env, fetchImpl: mock.fetchImpl })(request(create === createContactHandler ? contact : { action: 'test_telegram' }));
    const body = await response.text();
    for (const secret of [token, runtime.chatId, runtime.salt, 'server-only-test-key']) assert.equal(body.includes(secret), false);
    assert.ok(response.status >= 500);
  }
});

test('public config rejects privileged keys and Telegram validates replacements', () => {
  const jwt = (role) => 'eyJheader.' + btoa(JSON.stringify({ role })) + '.signature';
  assert.equal(validatePublicConfig('https://test.supabase.co/', 'sb_publishable_example').supabaseUrl, 'https://test.supabase.co');
  assert.equal(validatePublicConfig('https://test.supabase.co', jwt('anon')).supabaseKey, jwt('anon'));
  for (const key of ['sb_secret_rejected', jwt('service_role'), 'management-token']) assert.throws(() => validatePublicConfig('https://test.supabase.co', key));
  assert.throws(() => validatePublicConfig('https://test.supabase.co.evil.example', 'sb_publishable_example'));
  const values = { bot_token: token, chat_id: '-1234567', hash_salt: '', enabled: true, origins: 'https://gulievi.me' };
  assert.equal(validateTelegram(values).p_bot_token, token);
  assert.equal(validateTelegram({ ...values, bot_token: '' }).p_bot_token, null);
  for (const update of [{ bot_token: 'invalid' }, { chat_id: 'invalid' }, { hash_salt: 'short' }, { origins: 'https://user:pass@example.com' }, { origins: 'http://evil.example' }]) assert.throws(() => validateTelegram({ ...values, ...update }));
  assert.throws(() => validateTelegram(values, true), 'demo must reject real-format secrets');
});

test('Supabase staging never forwards the active session to another project or changes bootstrap', async () => {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.sessionStorage;
  const active = { access_token: 'current-session-test-only', refresh_token: 'current-refresh-test-only', expires_at: Math.floor(Date.now()/1000)+3600 };
  let stored = JSON.stringify(active); const calls = [];
  try {
    globalThis.sessionStorage = { getItem: () => stored, setItem: (key,value) => { stored=value; }, removeItem: () => { stored=null; } };
    globalThis.fetch = async (url, options={}) => {
      calls.push({url,options});
      if (url.includes('/auth/v1/token')) return json({access_token:'target-session-test-only'});
      if (url.endsWith('/rpc/is_portfolio_admin')) return json(true);
      if (url.includes('/site_content')) return json([{id:'draft'},{id:'published'}]);
      if (url.includes('/categories')) return json([]);
      if (url.endsWith('/connection_status')) return json({revision:0});
      if (url.endsWith('/public_connection_settings')) return json({contactEnabled:false});
      throw new Error('Unexpected request');
    };
    let source = await readFile(new URL('../js/api.js',import.meta.url),'utf8');
    source=source.replace("import { config } from './config.js';", "const config={supabaseUrl:'https://current.supabase.co',supabaseKey:'sb_publishable_current',contactEnabled:false};")
      .replace("from './connections-validation.js'",`from ${JSON.stringify(new URL('../js/connections-validation.js',import.meta.url).href)}`)
      .replace("new URL('../', import.meta.url)",`new URL(${JSON.stringify(new URL('../',import.meta.url).href)})`);
    const api=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    await api.restoreSession();
    await assert.rejects(api.checkPublicConnection('https://target.supabase.co','sb_publishable_target','',''));
    const candidate=await api.checkPublicConnection('https://target.supabase.co','sb_publishable_target','owner@example.com','fake-target-password');
    assert.equal(candidate.supabaseUrl,'https://target.supabase.co');
    assert.equal(api.publicConfig().supabaseUrl,'https://current.supabase.co');
    assert.equal(stored,JSON.stringify(active));
    for (const call of calls.filter((call)=>call.url.startsWith('https://target.supabase.co'))) assert.notEqual(call.options.headers.Authorization,`Bearer ${active.access_token}`);
    const login=calls.find((call)=>call.url.includes('/auth/v1/token'));
    assert.equal(JSON.parse(login.options.body).email,'owner@example.com');
    assert.equal(JSON.stringify(candidate).includes('fake-target-password'),false);
  } finally { globalThis.fetch=previousFetch; globalThis.sessionStorage=previousStorage; }
});
