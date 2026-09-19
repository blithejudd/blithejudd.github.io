import { configured, listPhotos, photoUrl } from './api.js';
import { initialPhotos, categories, filterPhotos } from './data.js';

export async function initGallery() {
  const grid = document.querySelector('#gallery');
  const status = document.querySelector('#gallery-status');
  const retry = document.querySelector('#gallery-retry');
  const dialog = document.querySelector('#lightbox');
  const image = document.querySelector('#lightbox-image');
  const caption = document.querySelector('#lightbox-caption');
  let photos = [];
  let visible = [];
  let category = 'all';
  let current = 0;
  let touchStart = null;

  function show(index) {
    current = (index + visible.length) % visible.length;
    const photo = visible[current];
    image.src = photoUrl(photo);
    image.alt = photo.alt;
    caption.textContent = `${photo.title} — ${current + 1} / ${visible.length}`;
    document.querySelector('#lightbox-prev').disabled = visible.length < 2;
    document.querySelector('#lightbox-next').disabled = visible.length < 2;
  }

  function render() {
    visible = filterPhotos(photos, category);
    grid.replaceChildren();
    status.textContent = visible.length ? '' : 'ამ კატეგორიაში ფოტოები ჯერ არ არის.';
    document.querySelector('#photo-count').textContent = `${String(visible.length).padStart(2, '0')} ფოტო`;
    visible.forEach((photo, index) => {
      const article = document.createElement('article');
      article.className = 'photo-card';
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', `${photo.title} — ფოტოს ნახვა`);
      const frame = document.createElement('div');
      frame.className = 'photo-frame';
      const img = document.createElement('img');
      img.src = photoUrl(photo); img.alt = photo.alt; img.loading = 'lazy'; img.decoding = 'async';
      if (photo.source === 'local') {
        const base = photoUrl(photo).replace(/\/([^/]+)\.webp$/, '/optimized/$1');
        img.srcset = `${base}-480.webp 480w, ${base}-960.webp 960w`;
        img.sizes = '(max-width: 700px) 44vw, 42vw';
      }
      frame.append(img);
      const details = document.createElement('div');
      details.className = 'photo-caption';
      const text = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = photo.title;
      const label = document.createElement('p'); label.textContent = categories[photo.category] || '';
      const number = document.createElement('span'); number.className = 'photo-number'; number.textContent = String(index + 1).padStart(2, '0');
      text.append(title, label); details.append(text, number); button.append(frame, details); article.append(button); grid.append(article);
      button.addEventListener('click', () => { show(index); dialog.showModal(); });
    });
  }

  document.querySelector('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    category = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    render();
  });
  document.querySelector('#lightbox-close').addEventListener('click', () => dialog.close());
  document.querySelector('#lightbox-prev').addEventListener('click', () => show(current - 1));
  document.querySelector('#lightbox-next').addEventListener('click', () => show(current + 1));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(current + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  dialog.addEventListener('touchstart', (event) => { touchStart = event.touches.length === 1 ? event.touches[0].clientX : null; }, { passive: true });
  dialog.addEventListener('touchend', (event) => {
    if (touchStart !== null && event.changedTouches.length) {
      const distance = event.changedTouches[0].clientX - touchStart;
      if (Math.abs(distance) > 65) show(current + (distance < 0 ? 1 : -1));
    }
    touchStart = null;
  }, { passive: true });
  image.addEventListener('error', () => { caption.textContent = 'ფოტო ვერ ჩაიტვირთა. სცადეთ ხელახლა.'; });

  async function load() {
    retry.hidden = true; status.textContent = 'ფოტოები იტვირთება…';
    try {
      // Once connected, the database is authoritative: never resurrect hidden/deleted photos.
      photos = configured ? await listPhotos() : initialPhotos;
      render();
    } catch {
      status.textContent = 'გალერეა დროებით მიუწვდომელია. გთხოვთ, სცადოთ ხელახლა.';
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', load);
  await load();
}