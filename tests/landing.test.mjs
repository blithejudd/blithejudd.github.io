import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/js/config.js')) return { format: 'module', source: 'export const config = { supabaseUrl: "https://test.supabase.co", supabaseKey: "sb_publishable_test" };', shortCircuit: true };
  return nextLoad(url, context);
} });
const { initLanding } = await import('../js/landing.js');
hooks.deregister();

function element(dataset = {}, textContent = '') {
  return { dataset, textContent, children: [], append(child) { this.children.push(child); }, remove() { this.removed = true; } };
}
function page(language) {
  const services = { ...element(), hidden: true }, cards = Array.from({ length: 4 }, () => element());
  const prices = ['c078.text0', 'c083.text0', 'c088.text0', 'c093.text0'].map((landingPrice, index) => ({ ...element({ landingPrice, template: language === 'ru' ? 'От {price} ₾.' : 'From {price} ₾.' }, 'Ask for pricing.'), closest(selector) { return selector === 'section' ? services : cards[index]; } }));
  const contacts = Array.from({ length: 3 }, () => ({ ...element(), hidden: true }));
  const hero = element(), gallery = element(), status = element();
  globalThis.document = {
    querySelectorAll(selector) { return selector === '[data-landing-price]' ? prices : contacts; },
    querySelector(selector) { return { '[data-landing-hero]': hero, '[data-landing-gallery]': gallery, '[data-landing-status]': status }[selector]; },
    createElement() { return element(); },
  };
  return { prices, contacts, hero, gallery, status, services, cards };
}

test('landing uses only published CMS/photos, handles empty contact and falls back safely on outage', async () => {
  const originalFetch = globalThis.fetch;
  let outage = false;
  let values = { 'c098.href': '@new_profile', 'c034.image': { source: 'storage', image_path: '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.webp' } };
  for (const key of ['c078.text0', 'c083.text0', 'c088.text0', 'c093.text0']) values[key] = '₾350-დან';
  const photos = Array.from({ length: 6 }, (_, index) => ({ source: 'local', image_path: 'images/portfolio-1.webp', alt: `photo ${index}`, category: index === 1 ? 'hidden' : 'visible', published: index !== 0 }));
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'GET');
    if (outage) throw new Error('offline');
    if (url.includes('/categories')) return Response.json([{ id: 'hidden', visible: false }, { id: 'visible', visible: true }]);
    if (url.includes('/site_content')) {
      assert.match(url, /id=eq.published/);
      return Response.json([{ id: 'published', values }]);
    }
    assert.match(url, /published=eq.true/);
    return Response.json(photos);
  };
  try {
    for (const language of ['en', 'ru']) {
      const current = page(language); await initLanding();
      assert.equal(current.gallery.children.length, 3);
      assert.equal(current.gallery.children[0].alt, 'photo 2', 'hidden category photos never appear');
      assert.match(current.hero.children[0].src, /storage\/v1\/object\/public\/portfolio\//);
      assert.equal(current.prices.every((price) => price.textContent.includes('350')), true);
      assert.equal(current.contacts.every((link) => link.href === 'https://instagram.com/new_profile'), true);
      assert.equal(current.contacts.every((link) => link.hidden === false), true);
      assert.equal(current.services.hidden, false);
      assert.equal(current.status.hidden, true);
    }
    values = { ...values, 'c098.href': '', 'c078.text0': '<b>350</b>', 'hero.visible': false, 'portfolio.visible': false, 'services.visible': false, 'c074.visible': false, 'c084.visible': false };
    const hidden = page('en'); await initLanding();
    assert.equal(hidden.contacts.every((link) => link.removed), true);
    assert.equal(hidden.prices[0].textContent, 'Ask for pricing.');
    assert.equal(hidden.hero.children.length + hidden.gallery.children.length, 0);
    assert.equal(hidden.services.hidden, true);
    assert.deepEqual(hidden.cards.map((card) => card.hidden), [true, false, true, false]);
    outage = true;
    const offline = page('en'); await initLanding();
    assert.equal(offline.hero.children.length + offline.gallery.children.length, 0);
    assert.equal(offline.prices.every((price) => price.textContent === 'Ask for pricing.'), true);
    assert.equal(offline.contacts.every((link) => link.hidden && !link.href), true);
    assert.equal(offline.services.hidden, true);
  } finally { globalThis.fetch = originalFetch; delete globalThis.document; }
});

test('both landing documents have no stale inline photos or numeric prices', async () => {
  assert.match(await readFile(new URL('../css/landing.css', import.meta.url), 'utf8'), /\[hidden\]\{display:none!important\}/);
  for (const path of ['en/photographer-tbilisi/', 'ru/fotograf-tbilisi/']) {
    const html = await readFile(new URL(`../${path}index.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<img\b|220|450/);
    assert.equal((html.match(/data-landing-price=/g) || []).length, 4);
    assert.equal((html.match(/data-landing-instagram/g) || []).length, 3);
    assert.equal((html.match(/data-landing-instagram hidden/g) || []).length, 3);
    assert.doesNotMatch(html, /href="https:\/\/(?:www\.)?instagram\.com/);
    assert.match(html, /<section class="section wrap" hidden>/);
    assert.match(html, /src="\/js\/landing.js"/);
  }
});
