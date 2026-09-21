import { config } from './config.js';
import { validatePublicConfig } from './connections-validation.js';

export const preview = config.preview === true && typeof location !== 'undefined' && ['127.0.0.1', 'localhost'].includes(location.hostname) && config.supabaseUrl === `${location.origin}/preview-api`;
export const configured = (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl) || preview) && Boolean(config.supabaseKey);
const sessionKey = preview ? 'zuka-preview-session' : 'zuka-admin-session';
let session = null;
let refreshing = null;
export let contactEnabled = config.contactEnabled === true;

function saveSession(value) {
  session = value ? { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + value.expires_in } : null;
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch { /* A blocked session store still allows an in-memory session. */ }
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  if (!configured) throw new Error('ჯერ დააკავშირეთ Supabase js/config.js ფაილში README ინსტრუქციის მიხედვით.');
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
  } catch { throw new Error('სერვერი არ პასუხობს. შეამოწმეთ ინტერნეტი და სცადეთ ხელახლა.'); }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'სესია ამოიწურა ან ელფოსტა/პაროლი არასწორია. შედით ხელახლა.' : response.status === 403 ? 'წვდომა არ გაქვთ. შეამოწმეთ მფლობელის უფლებები Supabase-ში.' : response.status === 429 ? 'ძალიან ბევრი მოთხოვნაა. სცადეთ მოგვიანებით.' : `სერვერის შეცდომა (${response.status}). შეამოწმეთ Supabase-ის პარამეტრები და სცადეთ ხელახლა.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function accessToken() {
  if (!session) throw new Error('ჯერ შედით პანელში.');
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
    throw new Error('ეს ანგარიში პორტფოლიოს მფლობელად არ არის დანიშნული.');
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
  if (password.length < 12) throw new Error('ახალი პაროლი უნდა შეიცავდეს სულ მცირე 12 სიმბოლოს.');
  if (password === currentPassword) throw new Error('ახალი პაროლი უნდა განსხვავდებოდეს მიმდინარესგან.');
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
    if (!Array.isArray(page)) throw new Error('სერვერმა გალერეის მონაცემები არასწორი ფორმატით დააბრუნა.');
    result.push(...page);
    if (page.length < 500) return result;
  }
}

const siteRoot = new URL('../', import.meta.url);
export function photoUrl(photo) {
  if (photo.source === 'local' && /^images\/[a-z0-9-]+\.webp$/.test(photo.image_path)) return new URL(photo.image_path, siteRoot).href;
  if (photo.source === 'storage' && /^[a-f0-9-]+\/[a-f0-9-]+\.webp$/.test(photo.image_path)) return `${config.supabaseUrl}/storage/v1/object/public/portfolio/${photo.image_path}`;
  throw new Error('ფოტოს მისამართი არასწორია.');
}

export async function savePhoto(id, values) {
  const rows = await adminRequest(`/rest/v1/photos${id ? `?id=eq.${encodeURIComponent(id)}` : ''}`, {
    method: id ? 'PATCH' : 'POST', body: values, headers: { Prefer: 'return=representation' },
  });
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('ფოტო ვერ შეინახა. შესაძლოა, უკვე წაშლილია. განაახლეთ სია.');
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
  if (!Array.isArray(removed) || removed.length !== 1) throw new Error('ფოტო ვერ წაიშალა. განაახლეთ სია.');
  if (photo.source === 'storage') {
    try { await removeImage(photo.image_path); }
    catch { return 'ფოტო წაიშალა გალერეიდან, მაგრამ ფაილი დარჩა საცავში. წაშალეთ ხელით: ' + photo.image_path; }
  }
  return 'ფოტო წაშლილია.';
}

export async function sendContact(values) {
  if (!contactEnabled) throw new Error('საკონტაქტო ფორმა ჯერ არ არის დაკავშირებული.');
  return request('/functions/v1/contact', { method: 'POST', body: values });
}

export async function listCategories(admin = false) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const path = `/rest/v1/categories?select=*&order=sort_order.asc,id.asc&limit=500&offset=${offset}`;
    const page = await (admin ? adminRequest(path) : request(path));
    if (!Array.isArray(page)) throw new Error('კატეგორიების მონაცემები არასწორია.');
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

export async function saveCategory(id, values, create = false) {
  if (!values.name.trim() || values.name.length > 100 || !Number.isInteger(values.sort_order) || values.sort_order < 0 || values.sort_order > 1000000) throw new Error('შეამოწმეთ კატეგორიის სახელი და თანმიმდევრობა.');
  const rows = await adminRequest(`/rest/v1/categories${create ? '' : `?id=eq.${encodeURIComponent(id)}`}`, {
    method: create ? 'POST' : 'PATCH', body: { ...values, ...(create ? { id } : {}) }, headers: { Prefer: 'return=representation' },
  });
  if (rows?.length !== 1) throw new Error('კატეგორია ვერ შეინახა. განაახლეთ სია.');
  return rows[0];
}

export async function deleteCategory(id) {
  try {
    const rows = await adminRequest(`/rest/v1/categories?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    if (rows?.length !== 1) throw new Error('კატეგორია უკვე წაშლილია. განაახლეთ სია.');
  } catch (error) {
    if (error.status === 409) throw new Error('კატეგორიას ფოტოები აქვს. ჯერ გადაიტანეთ ისინი სხვა კატეგორიაში.');
    throw error;
  }
}

export async function getContent(admin = false) {
  const path = `/rest/v1/site_content?select=*${admin ? '' : '&id=eq.published'}`;
  const rows = await (admin ? adminRequest(path) : request(path));
  if (!Array.isArray(rows)) throw new Error('საიტის მონაცემები არასწორია.');
  return rows;
}

export async function saveContent(id, values, revision) {
  const rows = await adminRequest(`/rest/v1/site_content?id=eq.${id}&revision=eq.${revision}`, {
    method: 'PATCH', body: { values, revision: revision + 1 }, headers: { Prefer: 'return=representation' },
  });
  if (rows?.length !== 1) throw new Error('სხვა ჩანართში მონაცემები შეიცვალა. შეინახეთ თქვენი ტექსტები და განაახლეთ გვერდი.');
  return rows[0];
}

export async function loadConnectionSettings() {
  if (!configured) return false;
  try { contactEnabled = (await request('/rest/v1/rpc/public_connection_settings', { method: 'POST', body: {} }))?.contactEnabled === true; }
  catch (error) { contactEnabled = error.status === 404 && config.contactEnabled === true; }
  return contactEnabled;
}
export const connectionStatus = () => adminRequest('/rest/v1/rpc/connection_status', { method: 'POST', body: {} });
export const saveConnections = (values) => adminRequest('/rest/v1/rpc/save_connections', { method: 'POST', body: values });
export const testTelegram = () => adminRequest('/functions/v1/connections', { method: 'POST', body: { action: 'test_telegram' } });
export const publicConfig = () => ({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabaseKey });

export async function checkPublicConnection(url, key, email, password) {
  const candidate = validatePublicConfig(url, key);
  if (preview) return { ...candidate, simulated: true };
  async function target(path, body, token) {
    let response;
    try {
      response = await fetch(candidate.supabaseUrl + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: candidate.supabaseKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error('ახალი კავშირი ვერ დადასტურდა. შეამოწმეთ საჯარო გასაღები, ანგარიში და მიგრაციები. მოქმედი კავშირი არ შეცვლილა.'); }
  }
  let token;
  if (candidate.supabaseUrl === config.supabaseUrl) token = await accessToken();
  else {
    if (!email || !password) throw new Error('სხვა პროექტის შესამოწმებლად შეიყვანეთ მისი მფლობელის ელფოსტა და პაროლი.');
    // Never forward the active project's session to a different endpoint.
    token = (await target('/auth/v1/token?grant_type=password', { email, password })).access_token;
  }
  if (!token || await target('/rest/v1/rpc/is_portfolio_admin', {}, token) !== true) throw new Error('ახალ პროექტში მფლობელის უფლება არ გაქვთ.');
  const rows = await target('/rest/v1/site_content?select=id', undefined, token);
  if (!Array.isArray(rows) || !['draft', 'published'].every((id) => rows.some((row) => row.id === id))) throw new Error('ახალ პროექტში CMS მიგრაციები არ არის მზად.');
  await target('/rest/v1/categories?select=id&limit=1');
  await target('/rest/v1/rpc/connection_status', {}, token);
  await target('/rest/v1/rpc/public_connection_settings', {});
  return candidate;
}
