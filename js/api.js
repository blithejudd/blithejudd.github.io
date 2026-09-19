import { config } from './config.js';

export const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl) && Boolean(config.supabaseKey);
const sessionKey = 'zuka-admin-session';
let session = null;
let refreshing = null;

function saveSession(value) {
  session = value ? { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + value.expires_in } : null;
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch { /* A blocked session store still allows an in-memory session. */ }
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  if (!configured) throw new Error('Сначала подключите Supabase в js/config.js по инструкции README.');
  const requestHeaders = { apikey: config.supabaseKey, ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  else if (config.supabaseKey.startsWith('eyJ')) requestHeaders.Authorization = `Bearer ${config.supabaseKey}`;
  if (body !== undefined && !(body instanceof Blob)) requestHeaders['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}${path}`, {
      method, headers: requestHeaders,
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch { throw new Error('Нет ответа от сервера. Проверьте интернет и повторите попытку.'); }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Сессия истекла или неверный email/пароль. Войдите снова.' : response.status === 403 ? 'Нет доступа. Проверьте права владельца в Supabase.' : response.status === 429 ? 'Слишком много запросов. Попробуйте позже.' : `Ошибка сервера (${response.status}). Проверьте настройки Supabase и повторите попытку.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function accessToken() {
  if (!session) throw new Error('Сначала войдите в панель.');
  if (session.expires_at > Date.now() / 1000 + 90) return session.access_token;
  if (!refreshing) {
    refreshing = request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh_token },
    }).then(saveSession).catch((error) => {
      if (error.status === 400 || error.status === 401) saveSession(null);
      throw error;
    }).finally(() => { refreshing = null; });
  }
  await refreshing;
  return session.access_token;
}

async function adminRequest(path, options = {}) {
  return request(path, { ...options, token: await accessToken() });
}

export async function verifyAdmin() {
  const allowed = await adminRequest('/rest/v1/rpc/is_portfolio_admin', { method: 'POST', body: {} });
  if (allowed !== true) {
    saveSession(null);
    throw new Error('Этот аккаунт не назначен владельцем портфолио.');
  }
}

export async function restoreSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    if (stored?.access_token && stored?.refresh_token && Number.isFinite(stored.expires_at)) session = stored;
  } catch { session = null; }
  if (!session) return false;
  await verifyAdmin();
  return true;
}

export async function login(email, password) {
  saveSession(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
  try { await verifyAdmin(); } catch (error) { saveSession(null); throw error; }
}

export async function logout() {
  try { if (session) await adminRequest('/auth/v1/logout', { method: 'POST' }); }
  finally { saveSession(null); }
}

export async function changePassword(currentPassword, password) {
  if (password.length < 12) throw new Error('Новый пароль должен содержать не менее 12 символов.');
  if (password === currentPassword) throw new Error('Новый пароль должен отличаться от текущего.');
  const user = await adminRequest('/auth/v1/user');
  // Reauthenticate before changing credentials; never store the password.
  await login(user.email, currentPassword);
  await adminRequest('/auth/v1/user', { method: 'PUT', body: { password, current_password: currentPassword } });
}

export async function listPhotos(admin = false) {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const path = `/rest/v1/photos?select=*&order=sort_order.asc,id.asc&limit=500&offset=${offset}${admin ? '' : '&published=eq.true'}`;
    const page = admin ? await adminRequest(path) : await request(path);
    if (!Array.isArray(page)) throw new Error('Сервер вернул неверный формат галереи.');
    result.push(...page);
    if (page.length < 500) return result;
  }
}

const siteRoot = new URL('../', import.meta.url);
export function photoUrl(photo) {
  if (photo.source === 'local' && /^images\/[a-z0-9-]+\.webp$/.test(photo.image_path)) return new URL(photo.image_path, siteRoot).href;
  if (photo.source === 'storage' && /^[a-f0-9-]+\/[a-f0-9-]+\.webp$/.test(photo.image_path)) return `${config.supabaseUrl}/storage/v1/object/public/portfolio/${photo.image_path}`;
  throw new Error('Некорректный путь фотографии.');
}

export async function savePhoto(id, values) {
  const rows = await adminRequest(`/rest/v1/photos${id ? `?id=eq.${encodeURIComponent(id)}` : ''}`, {
    method: id ? 'PATCH' : 'POST', body: values, headers: { Prefer: 'return=representation' },
  });
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Фото не сохранено. Возможно, оно уже удалено. Обновите список.');
  return rows[0];
}

export async function uploadImage(blob) {
  const user = await adminRequest('/auth/v1/user');
  const path = `${user.id}/${crypto.randomUUID()}.webp`;
  await adminRequest(`/storage/v1/object/portfolio/${path}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/webp', 'x-upsert': 'false' } });
  return path;
}

export async function removeImage(path) {
  await adminRequest('/storage/v1/object/portfolio', { method: 'DELETE', body: { prefixes: [path] } });
}

export async function deletePhoto(photo) {
  const removed = await adminRequest(`/rest/v1/photos?id=eq.${encodeURIComponent(photo.id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!Array.isArray(removed) || removed.length !== 1) throw new Error('Фото не удалено. Обновите список.');
  if (photo.source === 'storage') {
    try { await removeImage(photo.image_path); }
    catch { return 'Фото удалено из галереи, но файл остался в Storage. Удалите его вручную: ' + photo.image_path; }
  }
  return 'Фото удалено.';
}

export async function sendContact(values) {
  if (!config.contactEnabled) throw new Error('Contact form is not configured.');
  return request('/functions/v1/contact', { method: 'POST', body: values });
}