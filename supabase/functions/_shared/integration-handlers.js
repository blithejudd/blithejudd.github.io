import { validateContact, telegramMessage } from '../contact/validation.js';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'apikey, content-type, authorization' };
const reply = (status, data, extra = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { ...headers, ...extra } });
const cors = (runtime, request) => runtime?.allowedOrigins?.includes(request.headers.get('origin')) ? { 'Access-Control-Allow-Origin': request.headers.get('origin') } : null;

async function jsonBody(request, limit = 16384) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Invalid body');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('Body limit'); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(data));
}

function platform(env, fetchImpl) {
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Unavailable');
  return async (path, body, authorization) => {
    const response = await fetchImpl(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: key, Authorization: authorization || `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Unavailable');
    return response.json();
  };
}

export function createContactHandler({ env, fetchImpl = fetch, cryptoImpl = crypto }) {
  return async (request) => {
    let allow = {};
    try {
      const backend = platform(env, fetchImpl);
      const runtime = await backend('/rest/v1/rpc/contact_runtime', {});
      allow = cors(runtime, request);
      if (!allow) return reply(403, { error: 'Origin not allowed' });
      if (request.method === 'OPTIONS') return reply(204, null, allow);
      if (request.method !== 'POST') return reply(405, { error: 'Method not allowed' }, allow);
      if (!runtime.enabled || !runtime.token || !runtime.chatId || !runtime.salt) return reply(503, { error: 'Contact unavailable' }, allow);
      let values;
      try { values = validateContact(await jsonBody(request)); }
      catch { return reply(400, { error: 'Invalid request' }, allow); }
      const categoryRows = await backend(`/rest/v1/categories?id=eq.${encodeURIComponent(values.category)}&visible=eq.true&select=name`);
      if (!Array.isArray(categoryRows) || categoryRows.length !== 1) return reply(400, { error: 'Invalid category' }, allow);
      const hash = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`${runtime.salt}:${values.contact.toLowerCase().replace(/\s/g, '')}`));
      const contactHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (await backend('/rest/v1/rpc/consume_contact_quota', { contact_hash: contactHash }) !== true) return reply(429, { error: 'Please try later' }, allow);
      const response = await fetchImpl(`https://api.telegram.org/bot${runtime.token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: runtime.chatId, text: telegramMessage({ ...values, category_name: categoryRows[0].name }), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) return reply(502, { error: 'Delivery failed' }, allow);
      return reply(200, { ok: true }, allow);
    } catch { return reply(503, { error: 'Contact unavailable' }, allow || {}); }
  };
}

export function createConnectionsHandler({ env, fetchImpl = fetch }) {
  return async (request) => {
    let allow = {};
    try {
      const backend = platform(env, fetchImpl);
      if (request.method !== 'OPTIONS') {
        const authorization = request.headers.get('authorization');
        if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'Unauthorized' });
        try {
          const user = await backend('/auth/v1/user', undefined, authorization);
          if (!user?.id || await backend('/rest/v1/rpc/is_portfolio_admin', {}, authorization) !== true) return reply(403, { error: 'Owner access required' });
        } catch { return reply(401, { error: 'Unauthorized' }); }
      }
      const runtime = await backend('/rest/v1/rpc/contact_runtime', {});
      allow = cors(runtime, request);
      if (!allow) return reply(403, { error: 'Origin not allowed' });
      if (request.method === 'OPTIONS') return reply(204, null, allow);
      if (request.method !== 'POST') return reply(405, { error: 'Method not allowed' }, allow);
      let body;
      try { body = await jsonBody(request, 1024); } catch { return reply(400, { error: 'Invalid request' }, allow); }
      if (body.action !== 'test_telegram') return reply(400, { error: 'Invalid action' }, allow);
      if (!runtime.token || !runtime.chatId) return reply(409, { error: 'Configuration incomplete' }, allow);
      // Explicit owner action, read-only methods. Never echo Telegram responses.
      const bot = await fetchImpl(`https://api.telegram.org/bot${runtime.token}/getMe`, { signal: AbortSignal.timeout(10000) });
      if (!bot.ok || (await bot.json()).ok !== true) return reply(502, { error: 'Connection check failed' }, allow);
      const chat = await fetchImpl(`https://api.telegram.org/bot${runtime.token}/getChat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: runtime.chatId }), signal: AbortSignal.timeout(10000),
      });
      if (!chat.ok || (await chat.json()).ok !== true) return reply(502, { error: 'Connection check failed' }, allow);
      return reply(200, { botValid: true, chatReachable: true }, allow);
    } catch { return reply(503, { error: 'Connection unavailable' }, allow || {}); }
  };
}
