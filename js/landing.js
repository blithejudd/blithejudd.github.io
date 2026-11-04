import { configured, getContent, listPhotos, listCategories, photoUrl } from './api.js';
import { normalizeContact } from './content.js';

export async function initLanding() {
  if (!configured) return;
  try {
    const [rows, photos, categories] = await Promise.all([getContent(), listPhotos(), listCategories()]);
    const values = rows[0]?.values;
    if (!values || typeof values !== 'object') return;
    const instagram = normalizeContact('instagram', values['c098.href'] || '');
    const hero = values['hero.visible'] !== false && values['c034.image'] ? photoUrl(values['c034.image']) : '';
    const visibleCategories = new Set(categories.filter((category) => category.visible).map((category) => category.id));
    const gallery = values['portfolio.visible'] === false ? [] : photos.filter((photo) => photo.published === true && visibleCategories.has(photo.category)).slice(0, 3).map((photo) => ({ src: photoUrl(photo), alt: photo.alt || '' }));
    document.querySelectorAll('[data-landing-instagram]').forEach((link) => {
      if (instagram) link.href = instagram; else link.remove();
    });
    document.querySelectorAll('[data-landing-price]').forEach((element, index) => {
      element.closest('section').hidden = values['services.visible'] === false;
      element.closest('.card').hidden = values[['c074.visible', 'c079.visible', 'c084.visible', 'c089.visible'][index]] === false;
      const price = /^\s*₾(\d+(?:\.\d{1,2})?)-\u10d3\u10d0\u10dc\s*$/.exec(values[element.dataset.landingPrice] || '');
      if (price) element.textContent = element.dataset.template.replace('{price}', price[1]);
    });
    if (hero) {
      const image = document.createElement('img'); image.src = hero; image.alt = values['c034.alt'] || ''; image.width = 1365; image.height = 2048;
      document.querySelector('[data-landing-hero]').append(image);
    }
    const grid = document.querySelector('[data-landing-gallery]');
    for (const photo of gallery) {
      const image = document.createElement('img'); image.src = photo.src; image.alt = photo.alt; image.loading = 'lazy'; image.decoding = 'async'; image.width = 480; image.height = 640; grid.append(image);
    }
    document.querySelector('[data-landing-status]').hidden = gallery.length > 0;
  } catch { /* Keep biography, service descriptions and the confirmed contact available during an outage. */ }
}

if (typeof document !== 'undefined') initLanding();
