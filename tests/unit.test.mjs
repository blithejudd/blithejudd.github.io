import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initialPhotos, filterPhotos, validatePhoto, validateImage } from '../js/data.js';
import { photoUrl } from '../js/api.js';
import { contactDate } from '../js/forms.js';
import { validateContent, normalizeContact } from '../js/content.js';
import { validateContact, telegramMessage } from '../supabase/functions/contact/validation.js';

const root = new URL('../', import.meta.url);
const validPhoto = { title: '  История  ', alt: 'Портрет', category: 'portraits', sort_order: '10', published: true };
const contact = { name: 'Имя', contact: 'hello@example.com', category: 'family', date: '2026-10-10', message: 'Привет', website: '' };

test('public contacts normalize phone and Instagram and reject unsafe/profile-invalid URLs', () => {
  assert.equal(normalizeContact('phone', '+995 (555) 12-34-56'), '+995555123456');
  for (const input of ['@Example.User', 'https://www.instagram.com/Example.User/?igsh=share', 'instagram.com/Example.User']) assert.equal(normalizeContact('instagram', input), 'https://instagram.com/example.user');
  for (const type of ['phone', 'instagram']) assert.equal(normalizeContact(type, '  '), '');
  for (const input of ['javascript:alert(1)', 'https://instagram.com.evil.com/user', 'https://evil.com/user', 'https://user:pass@instagram.com/user', 'http://instagram.com/user', 'https://instagram.com/p/123', 'https://instagram.com/accounts/', 'bad..name', 'name/', '<img>']) assert.throws(() => normalizeContact('instagram', input));
  for (const input of ['tel:+995555123456', '+995555123456?x=1', '123', '+1234567890123456', 'javascript:alert(1)']) assert.throws(() => normalizeContact('phone', input));
  assert.deepEqual(validateContent([{ key: 'footer.phone', type: 'phone' }, { key: 'c098.href', type: 'instagram' }], { 'footer.phone': '+995 555 12 34 56', 'c098.href': '@Example' }), { 'footer.phone': '+995555123456', 'c098.href': 'https://instagram.com/example' });
});

test('Georgian date input preserves ISO payload and rejects impossible dates', () => {
  assert.equal(contactDate(''), '');
  assert.equal(contactDate('25.12.2026'), '2026-12-25');
  assert.equal(contactDate('29.02.2028'), '2028-02-29');
  for (const value of ['29.02.2026', '31.04.2026', '00.01.2026', '01.13.2026', '25.12.0000', '2026-12-25', '1.1.2026']) assert.throws(() => contactDate(value));
});

test('content validation rejects unsafe links, invalid images and out-of-range layout values', () => {
  const fields = [{ key: 'text', type: 'text' }, { key: 'link', type: 'link' }, { key: 'image', type: 'image' }, { key: 'visible', type: 'boolean' }, { key: 'position', type: 'position' }];
  assert.deepEqual(validateContent(fields, { text: '<b>plain text</b>', link: 'https://instagram.com/example', unknown: 'ignored' }), { text: '<b>plain text</b>', link: 'https://instagram.com/example' });
  for (const values of [{ link: 'javascript:alert(1)' }, { link: 'https://user:password@example.com' }, { image: { source: 'local', image_path: '../secret' } }, { visible: 'false' }, { position: 101 }, { text: 'a'.repeat(5001) }]) assert.throws(() => validateContent(fields, values));
  assert.equal(validatePhoto({ ...validPhoto, category: 'architecture' }, { architecture: 'არქიტექტურა' }).category, 'architecture');
  assert.equal(validateContact({ ...contact, category: 'c-new-category' }).category, 'c-new-category');
});

test('site UI sources are Georgian and avoid browser-localized date controls', async () => {
  for (const file of ['index.html', 'admin/index.html', ...(await readdir(new URL('js/', root))).map((name) => `js/${name}`)]) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, /[А-Яа-яЁё]/, file);
  }
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.doesNotMatch(html, /type="date"/);
  assert.match(html, /id="hero-title" class="autograph hero-autograph" lang="en">Zuka Gulievi/);
});

test('initial gallery: six unique photos, stable order and valid local assets', async () => {
  assert.equal(initialPhotos.length, 6);
  assert.equal(new Set(initialPhotos.map((photo) => photo.image_path)).size, 6);
  for (const photo of initialPhotos) {
    await access(new URL(photo.image_path, root));
    for (const width of [480, 960]) await access(new URL(photo.image_path.replace(/images\/(.+)\.webp/, `images/optimized/$1-${width}.webp`), root));
    validatePhoto(photo);
    assert.ok(photoUrl(photo).endsWith(photo.image_path));
  }
});
test('gallery filters never expose unpublished photos', () => {
  const photos = [...initialPhotos, { ...initialPhotos[0], published: false }];
  assert.equal(filterPhotos(photos, 'all').length, 6);
  assert.equal(filterPhotos(photos, 'family').length, 4);
  assert.equal(filterPhotos(photos, 'weddings').length, 0);
});
test('photo validation trims text and rejects invalid fields', () => {
  assert.equal(validatePhoto(validPhoto).title, 'История');
  for (const change of [{ title: ' ' }, { alt: '' }, { category: 'admin' }, { sort_order: -1 }, { sort_order: 1.2 }, { sort_order: 1000001 }]) {
    assert.throws(() => validatePhoto({ ...validPhoto, ...change }));
  }
});
test('image validation blocks SVG, HEIC, empty and oversized files', () => {
  validateImage({ type: 'image/jpeg', size: 100 });
  for (const file of [{ type: 'image/svg+xml', size: 100 }, { type: 'image/heic', size: 100 }, { type: 'image/webp', size: 0 }, { type: 'image/png', size: 21 * 1024 * 1024 }]) assert.throws(() => validateImage(file));
});
test('image paths cannot inject external URLs or traverse folders', () => {
  for (const image_path of ['javascript:alert(1)', 'https://evil.example/a.webp', 'images/../secret.webp', 'images/x.svg']) assert.throws(() => photoUrl({ source: 'local', image_path }));
  assert.throws(() => photoUrl({ source: 'storage', image_path: '../secret' }));
});
test('unconfigured backend fails explicitly instead of simulating uploads', async () => {
  const source = (await readFile(new URL('js/api.js', root), 'utf8')).replace(
    "import { config } from './config.js';",
    "const config = { supabaseUrl: '', supabaseKey: '', contactEnabled: false };",
  ).replace("from './connections-validation.js'", `from ${JSON.stringify(new URL('js/connections-validation.js', root).href)}`).replace("new URL('../', import.meta.url)", `new URL(${JSON.stringify(root.href)})`);
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(api.configured, false);
  await assert.rejects(api.listPhotos(), /Supabase/);
});
test('contact validation accepts normal requests and rejects malformed requests', () => {
  assert.deepEqual(validateContact(contact), { name: contact.name, contact: contact.contact, category: contact.category, date: contact.date, message: contact.message });
  for (const change of [{ name: '' }, { contact: 'x' }, { website: 'spam' }, { category: '../other' }, { date: '2026-02-30' }, { message: 'x'.repeat(2001) }]) assert.throws(() => validateContact({ ...contact, ...change }));
  assert.throws(() => validateContact(null));
  assert.ok(telegramMessage({ ...contact, message: '<b>text</b>' }).includes('<b>text</b>'));
});
test('local HTML references exist and IDs are unique', async () => {
  for (const relative of ['index.html', 'admin/index.html']) {
    const file = new URL(relative, root);
    const html = await readFile(file, 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size);
    for (const [, value] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(?:https?:|#)/.test(value)) continue;
      await access(new URL(value, file));
    }
  }
});
test('browser source contains no private credentials or dynamic HTML injection', async () => {
  const files = await readdir(new URL('js/', root));
  for (const file of files) {
    const source = await readFile(new URL(`js/${file}`, root), 'utf8');
    assert.doesNotMatch(source, /\d{8,12}:[A-Za-z0-9_-]{30,}/);
    assert.doesNotMatch(source, /sb_secret_[A-Za-z0-9]+/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /cdn\.tailwindcss\.com/);
  }
});
test('RLS restricts admin list, writes and contact RPC', async () => {
  const sql = await readFile(new URL('supabase/schema.sql', root), 'utf8');
  assert.match(sql, /alter table public\.photos enable row level security/i);
  assert.match(sql, /revoke all on public\.portfolio_admins from anon, authenticated/i);
  assert.match(sql, /with check \(\(select public\.is_portfolio_admin\(\)\)\)/i);
  assert.match(sql, /revoke all on function public\.consume_contact_quota\(text\) from public, anon, authenticated/i);
  assert.match(sql, /file_size_limit/);
});
test('portfolio has a local signature font, biography and no staggered gallery rules', async () => {
  const css = await readFile(new URL('css/site.css', root), 'utf8');
  const html = await readFile(new URL('index.html', root), 'utf8');
  const font = await readFile(new URL('fonts/allura.ttf', root));
  assert.equal(font.readUInt32BE(0), 0x00010000, 'valid TrueType font');
  await access(new URL('fonts/OFL-Allura.txt', root));
  assert.doesNotMatch(css, /\.photo-card:nth-child/);
  assert.match(css, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(html, /class="autograph signature" lang="en">Zuka Gulievi/);
  assert.match(html, /class="about-facts"/);
});
