import { validateContact, telegramMessage } from './validation.js';

// Runs only in Supabase Edge Functions. No secret is sent to the browser.
Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin') || '';
  const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim()).filter(Boolean);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'apikey, content-type, authorization',
    'Cache-Control': 'no-store',
  };
  const reply = (status: number, error?: string) => new Response(JSON.stringify(error ? { error } : { ok: true }), { status, headers });
  if (!allowedOrigins.includes(origin)) return reply(403, 'Origin not allowed');
  headers['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, 'Method not allowed');
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, 'JSON required');

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const salt = Deno.env.get('CONTACT_HASH_SALT');
  if (!token || !chatId || !url || !serviceKey || !salt) return reply(503, 'Contact unavailable');

  let values;
  try {
    // Enforce an actual streaming limit, not just a spoofable Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return reply(400, 'Missing body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); return reply(413, 'Request too large'); }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    values = validateContact(JSON.parse(new TextDecoder().decode(body)));
  } catch { return reply(400, 'Invalid request'); }

  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${values.contact.toLowerCase().replace(/\s/g, '')}`));
    const contactHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const quota = await fetch(`${url}/rest/v1/rpc/consume_contact_quota`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_hash: contactHash }), signal: AbortSignal.timeout(10000),
    });
    if (!quota.ok) return reply(503, 'Contact unavailable');
    if (await quota.json() !== true) return reply(429, 'Please try later');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: telegramMessage(values), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) return reply(502, 'Delivery failed');
    return reply(200);
  } catch { return reply(502, 'Delivery failed'); }
});