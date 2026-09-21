// Loopback-only development backend. Never used by GitHub Pages or Supabase.
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialPhotos, initialCategories, validatePhoto } from '../js/data.js';
import { validateTelegram } from '../js/connections-validation.js';
import { validateContact } from '../supabase/functions/contact/validation.js';

export async function createPreviewApi(root) {
  const directory = path.join(root, 'test-results');
  const assets = path.join(directory, 'cms-preview-assets');
  const statePath = path.join(directory, 'cms-preview.json');
  await mkdir(assets, { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { photos: structuredClone(initialPhotos), categories: structuredClone(initialCategories), site_content: ['draft', 'published'].map((id) => ({ id, values: {}, revision: 0 })) };
  }
  const ownerId = '11111111-1111-4111-8111-111111111111';
  state.connections ||= { enabled: false, tokenConfigured: false, chatConfigured: false, saltConfigured: true, allowedOrigins: [], revision: 0 };
  const token = randomUUID();
  let writes = Promise.resolve();
  async function persist() {
    const serialized = JSON.stringify(state, null, 2);
    writes = writes.catch(() => {}).then(async () => { await writeFile(statePath + '.tmp', serialized); await rename(statePath + '.tmp', statePath); });
    await writes;
  }
  return async (url, request, response) => {
    if (url.pathname !== '/js/config.js' && !url.pathname.startsWith('/preview-api/')) return false;
    const origin = `http://${request.headers.host}`;
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); return true; };
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(request.headers.host || '') || (request.headers.origin && request.headers.origin !== origin)) return reply(403, {});
    if (url.pathname === '/js/config.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(`export const config = ${JSON.stringify({ supabaseUrl: origin + '/preview-api', supabaseKey: 'local-preview', contactEnabled: false, preview: true })};`); return true;
    }
    const route = url.pathname.slice('/preview-api'.length);
    if (route === '/demo-access' && request.method === 'GET') return reply(200, { email: 'demo@example.com', password: 'demo-password' });
    const admin = request.headers.authorization === `Bearer ${token}`;
    let bytes = Buffer.alloc(0), body;
    if (request.method !== 'GET') {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8388608) return reply(413, {}); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
      if (bytes.length && request.headers['content-type']?.startsWith('application/json')) {
        try { body = JSON.parse(bytes.toString()); } catch { return reply(400, {}); }
      }
    }
    if (route === '/auth/v1/token') {
      const allowed = url.searchParams.get('grant_type') === 'refresh_token' ? body?.refresh_token === token : body?.email === 'demo@example.com' && body?.password === 'demo-password';
      return allowed ? reply(200, { access_token: token, refresh_token: token, expires_in: 3600 }) : reply(401, {});
    }
    if (route === '/auth/v1/user') return reply(admin && request.method === 'GET' ? 200 : 403, { id: ownerId, email: 'demo@example.com' });
    if (route === '/auth/v1/logout') return reply(admin ? 200 : 401, {});
    if (route === '/rest/v1/rpc/is_portfolio_admin') return reply(admin ? 200 : 401, admin);
    const connectionState = () => ({ ...state.connections, allowedOrigins: state.connections.allowedOrigins.length ? state.connections.allowedOrigins : [origin] });
    if (route === '/rest/v1/rpc/public_connection_settings') return reply(200, { contactEnabled: state.connections.enabled && state.connections.tokenConfigured && state.connections.chatConfigured });
    if (route === '/rest/v1/rpc/contact_runtime' || route === '/rest/v1/integration_settings') return reply(403, {});
    if (route === '/rest/v1/rpc/connection_status') return reply(admin ? 200 : 403, admin ? connectionState() : {});
    if (route === '/rest/v1/rpc/save_connections') {
      if (!admin) return reply(403, {});
      if (request.method !== 'POST' || !body || typeof body.p_enabled !== 'boolean' || !Array.isArray(body.p_origins)) return reply(400, {});
      if (body.p_revision !== state.connections.revision) return reply(409, {});
      let values;
      try { values = validateTelegram({ bot_token: body.p_bot_token || '', chat_id: body.p_chat_id || '', hash_salt: body.p_hash_salt || '', origins: body.p_origins.join('\n'), enabled: body.p_enabled }, true); }
      catch { return reply(400, {}); }
      const tokenConfigured = state.connections.tokenConfigured || values.p_bot_token === 'demo-bot-token';
      const chatConfigured = state.connections.chatConfigured || values.p_chat_id === 'demo-chat-id';
      if (values.p_enabled && (!tokenConfigured || !chatConfigured)) return reply(400, {});
      // The demo persists booleans only, never replacement values (even fake ones).
      state.connections = { enabled: values.p_enabled, tokenConfigured, chatConfigured, saltConfigured: true, allowedOrigins: values.p_origins, revision: state.connections.revision + 1 };
      await persist(); return reply(200, connectionState());
    }
    if (route === '/functions/v1/connections') {
      if (!admin) return reply(403, {});
      if (body?.action !== 'test_telegram' || !state.connections.tokenConfigured || !state.connections.chatConfigured) return reply(409, {});
      return reply(200, { botValid: true, chatReachable: true, simulated: true });
    }
    if (route === '/functions/v1/contact') {
      if (!state.connections.enabled) return reply(503, {});
      try { const values = validateContact(body); if (!state.categories.some((row) => row.id === values.category && row.visible)) return reply(400, {}); }
      catch { return reply(400, {}); }
      return reply(200, { ok: true, simulated: true });
    }
    const publicFile = /^\/storage\/v1\/object\/public\/portfolio\/([a-f0-9-]+)\/([a-f0-9-]+\.webp)$/.exec(route);
    if (publicFile && request.method === 'GET') {
      try { const data = await readFile(path.join(assets, `${publicFile[1]}-${publicFile[2]}`)); response.writeHead(200, { 'Content-Type': 'image/webp' }); response.end(data); return true; }
      catch { return reply(404, {}); }
    }
    if (route.startsWith('/storage/')) {
      if (!admin) return reply(403, {});
      const upload = /^\/storage\/v1\/object\/portfolio\/([a-f0-9-]+)\/([a-f0-9-]+\.webp)$/.exec(route);
      if (upload && request.method === 'POST' && upload[1] === ownerId && request.headers['content-type'] === 'image/webp') {
        await writeFile(path.join(assets, `${upload[1]}-${upload[2]}`), bytes, { flag: 'wx' }); return reply(200, {});
      }
      if (route === '/storage/v1/object/portfolio' && request.method === 'DELETE' && Array.isArray(body?.prefixes)) {
        for (const file of body.prefixes) {
          if (!/^[a-f0-9-]+\/[a-f0-9-]+\.webp$/.test(file)) return reply(400, {});
          await unlink(path.join(assets, file.replace('/', '-'))).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
        return reply(200, {});
      }
      return reply(400, {});
    }
    const table = route.replace('/rest/v1/', '');
    if (!['photos', 'categories', 'site_content'].includes(table)) return reply(404, {});
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    if (request.method === 'GET') {
      let rows = state[table].filter((row) => !id || row.id === id);
      if (!admin) rows = rows.filter((row) => table === 'photos' ? row.published && state.categories.some((category) => category.id === row.category && category.visible) : table === 'categories' ? row.visible : row.id === 'published');
      if (url.searchParams.has('published')) rows = rows.filter((row) => row.published);
      rows = [...rows].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id.localeCompare(b.id));
      const offset = Number(url.searchParams.get('offset') || 0); const limit = Number(url.searchParams.get('limit') || 1000);
      return reply(200, rows.slice(offset, offset + limit));
    }
    if (!admin) return reply(403, {});
    const existing = state[table].find((row) => row.id === id);
    if (request.method === 'DELETE' && table !== 'site_content') {
      if (table === 'categories' && state.photos.some((photo) => photo.category === id)) return reply(409, {});
      state[table] = state[table].filter((row) => row.id !== id); await persist(); return reply(200, existing ? [existing] : []);
    }
    if (!['POST', 'PATCH'].includes(request.method) || !body || typeof body !== 'object') return reply(400, {});
    if (request.method === 'PATCH' && !existing) return reply(200, []);
    const row = { ...existing, ...body, id: existing?.id || body.id || randomUUID() };
    try {
      if (table === 'photos') {
        Object.assign(row, validatePhoto(row, Object.fromEntries(state.categories.map((category) => [category.id, category.name]))));
        if (!(row.source === 'local' && /^images\/[a-z0-9-]+\.webp$/.test(row.image_path)) && !(row.source === 'storage' && /^[a-f0-9-]+\/[a-f0-9-]+\.webp$/.test(row.image_path))) return reply(400, {});
        if (state.photos.some((photo) => photo.id !== row.id && photo.image_path === row.image_path)) return reply(409, {});
      } else if (table === 'categories') {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || row.id === 'all' || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100 || !Number.isInteger(row.sort_order) || row.sort_order < 0 || row.sort_order > 1000000 || typeof row.visible !== 'boolean') return reply(400, {});
      } else {
        if (request.method !== 'PATCH' || Number(url.searchParams.get('revision')?.replace('eq.', '')) !== existing.revision) return reply(200, []);
        if (!row.values || Array.isArray(row.values) || typeof row.values !== 'object' || Buffer.byteLength(JSON.stringify(row.values)) > 1048576) return reply(400, {});
        row.revision = existing.revision + 1;
      }
    } catch { return reply(400, {}); }
    if (existing) state[table] = state[table].map((item) => item.id === id ? row : item);
    else { if (state[table].some((item) => item.id === row.id)) return reply(409, {}); state[table].push(row); }
    await persist(); return reply(200, [row]);
  };
}
