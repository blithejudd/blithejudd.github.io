import { configured, getContent, photoUrl, preview } from './api.js';

export const sectionNames = { metadata: 'საიტის ინფორმაცია', header: 'მენიუ', hero: 'მთავარი ეკრანი', portfolio: 'პორტფოლიო', about: 'ჩემ შესახებ', services: 'სერვისები და ფასები', contact: 'კონტაქტი', footer: 'გვერდის ბოლო' };

export function normalizeContact(type, value) {
  if (typeof value !== 'string' || value.length > 5000) throw new Error('შეამოწმეთ საკონტაქტო ინფორმაცია.');
  value = value.trim();
  if (!value) return '';
  if (type === 'phone') {
    if (!/^\+?[\d ()-]+$/.test(value)) throw new Error('ტელეფონი შეიყვანეთ ქვეყნის კოდით, ციფრებით.');
    const phone = value.replace(/[ ()-]/g, '');
    if (!/^\+?\d{7,15}$/.test(phone)) throw new Error('ტელეფონი უნდა შეიცავდეს 7–15 ციფრს.');
    return phone;
  }
  let username = value.replace(/^@/, '');
  if (/^(https?:\/\/|(?:www\.)?instagram\.com\/)/i.test(value)) {
    let url;
    try { url = new URL(/^https?:/i.test(value) ? value : `https://${value}`); } catch { throw new Error('შეიყვანეთ Instagram-ის პროფილი ან @სახელი.'); }
    if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.port || url.username || url.password || !/^\/[^/]+\/?$/.test(url.pathname)) throw new Error('შეიყვანეთ Instagram-ის პროფილის უსაფრთხო ბმული.');
    username = url.pathname.replace(/^\/|\/$/g, '');
  }
  if (!/^[a-z\d_](?:[a-z\d_.]{0,28}[a-z\d_])?$/i.test(username) || username.includes('..') || /^(p|reel|reels|stories|explore|accounts|direct|about|legal)$/i.test(username)) throw new Error('შეიყვანეთ Instagram-ის პროფილი ან @სახელი.');
  return `https://instagram.com/${username.toLowerCase()}`;
}

export function contentFields(root) {
  const fields = [];
  for (const element of root.querySelectorAll('[data-content]')) {
    if (element.closest('noscript, #gallery, #gallery-status, #photo-count, #contact-status, #lightbox, .honeypot') || element.id === 'year' || (element.dataset.filter && element.dataset.filter !== 'all')) continue;
    const section = element.closest('section');
    const group = section?.id || (section?.classList.contains('hero') ? 'hero' : element.closest('header') ? 'header' : element.closest('footer') ? 'footer' : 'metadata');
    const add = (suffix, type, label, value, apply) => fields.push({ key: `${element.dataset.content}.${suffix}`, group, type, label, value, apply });
    [...element.childNodes].forEach((node, index) => {
      if (node.nodeType !== 3 || !/[\p{L}\p{N}]/u.test(node.textContent)) return;
      add(`text${index}`, 'text', node.textContent.trim(), node.textContent, (value) => { node.textContent = value; });
    });
    for (const attr of ['alt', 'aria-label']) {
      if (element.hasAttribute(attr)) add(attr, 'text', `${attr === 'alt' ? 'ფოტოს აღწერა' : 'ხელმისაწვდომი სახელი'}: ${element.getAttribute(attr)}`, element.getAttribute(attr), (value) => element.setAttribute(attr, value));
    }
    if (element.matches('meta[name="description"], meta[property="og:title"], meta[property="og:description"]')) {
      add('content', 'text', element.getAttribute('name') === 'description' ? 'საიტის აღწერა' : element.getAttribute('property') === 'og:title' ? 'გაზიარების სათაური' : 'გაზიარების აღწერა', element.content, (value) => { element.content = value; });
    }
    if (element.dataset.content === 'c098') add('href', 'instagram', 'Instagram — @სახელი ან პროფილის ბმული (ცარიელი ველი დამალავს)', element.getAttribute('href') || '', (value) => {
      root.querySelectorAll('[data-instagram]').forEach((link) => {
        link.hidden = !value;
        if (value) link.href = value; else link.removeAttribute('href');
        const account = link.querySelector('[data-account]');
        if (account) account.textContent = value ? '@' + new URL(value).pathname.slice(1) : '';
      });
    });
    else if (element.matches('a[href^="https:"]:not([data-instagram])')) add('href', 'link', 'ბმული: ' + element.textContent.trim(), element.getAttribute('href'), (value) => { element.href = value; });
    if (element.matches('img[src], meta[property="og:image"]')) {
      const path = element.tagName === 'IMG' ? element.getAttribute('src') : 'images/hero-bg.webp';
      add('image', 'image', element.alt || 'გაზიარების ფოტო', { source: 'local', image_path: path }, (value) => {
        if (element.tagName === 'IMG') { element.src = photoUrl(value); element.removeAttribute('srcset'); element.removeAttribute('sizes'); }
        else element.content = photoUrl(value);
      });
      if (element.tagName === 'IMG') for (const axis of ['x', 'y']) {
        add(axis, 'position', axis === 'x' ? 'ფოტოს ჰორიზონტალური ცენტრი (%)' : 'ფოტოს ვერტიკალური ცენტრი (%)', axis === 'y' && group === 'hero' ? 37 : 50, (value) => {
          element.dataset[axis] = value;
          element.style.objectPosition = `${element.dataset.x || 50}% ${element.dataset.y || (group === 'hero' ? 37 : 50)}%`;
        });
      }
    }
    if (element.classList.contains('service-row')) {
      add('visible', 'boolean', 'სერვისი გამოჩნდეს: ' + element.querySelector('h3').textContent, true, (value) => { element.hidden = !value; });
      add('order', 'order', 'სერვისის თანმიმდევრობა: ' + element.querySelector('h3').textContent, [...root.querySelectorAll('.service-row')].indexOf(element) * 10, (value) => { element.dataset.serviceOrder = value; });
    }
  }
  [...root.querySelectorAll('main > section')].forEach((section, index) => {
    const group = section.id || 'hero';
    fields.push({ key: `${group}.visible`, group, type: 'boolean', label: 'განყოფილება გამოჩნდეს საიტზე', value: true, apply(value) {
      section.hidden = !value;
      if (section.id) root.querySelectorAll(`a[href="#${section.id}"]`).forEach((link) => { link.hidden = !value; });
    } });
    fields.push({ key: `${group}.order`, group, type: 'order', label: 'განყოფილების თანმიმდევრობა', value: index * 10, apply(value) { section.dataset.order = value; } });
  });
  if (root.querySelector('#footer-phone')) fields.push({ key: 'footer.phone', group: 'contact', type: 'phone', label: 'საჯარო ტელეფონი — ქვეყნის კოდით (ცარიელი ველი დამალავს)', value: '', apply(value) {
    const link = root.querySelector('#footer-phone'); link.hidden = !value;
    if (value) link.href = `tel:${value}`; else link.removeAttribute('href');
    link.querySelector('[data-number]').textContent = value;
  } });
  return fields;
}

export function validateContent(fields, values) {
  const clean = {};
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) continue;
    const value = values[field.key];
    if (field.type === 'image') photoUrl(value);
    else if (field.type === 'boolean') { if (typeof value !== 'boolean') throw new Error('შეამოწმეთ ხილვადობა.'); }
    else if (field.type === 'order' || field.type === 'position') {
      if (!Number.isInteger(value) || value < 0 || value > (field.type === 'position' ? 100 : 1000000)) throw new Error('შეამოწმეთ თანმიმდევრობა ან ფოტოს ცენტრი.');
    } else {
      if (typeof value !== 'string' || value.length > 5000) throw new Error('ტექსტი უნდა იყოს 5000 სიმბოლომდე.');
      if (field.type === 'link') {
        let url;
        try { url = new URL(value); } catch { throw new Error('შეიყვანეთ სრული HTTPS ბმული.'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('შეიყვანეთ უსაფრთხო HTTPS ბმული.');
      }
    }
    clean[field.key] = ['phone', 'instagram'].includes(field.type) ? normalizeContact(field.type, value) : value;
  }
  return clean;
}

export function applyContent(root, values) {
  const fields = contentFields(root);
  const clean = validateContent(fields, values);
  fields.forEach((field) => { if (Object.hasOwn(clean, field.key)) field.apply(clean[field.key]); else if (['order', 'phone', 'instagram'].includes(field.type)) field.apply(field.value); });
  const contacts = root.querySelector('#footer-contacts');
  if (contacts) contacts.hidden = !contacts.querySelector('a:not([hidden])');
  const main = root.querySelector('main');
  if (main) [...main.children].filter((el) => el.tagName === 'SECTION').sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0)).forEach((el) => main.append(el));
  const services = root.querySelector('#services');
  if (services) [...services.querySelectorAll('.service-row')].sort((a, b) => Number(a.dataset.serviceOrder || 0) - Number(b.dataset.serviceOrder || 0)).forEach((el) => services.append(el));
}

export async function initContent() {
  if (preview) {
    const note = document.createElement('p'); note.className = 'preview-note';
    note.textContent = 'ლოკალური დემო — ცვლილებები ნამდვილ საიტს არ ეხება.';
    document.body.prepend(note);
  }
  if (!configured) return;
  if (new URLSearchParams(location.search).has('draft-preview')) return;
  const surfaces = [...document.querySelectorAll('.site-header, main, .site-footer')];
  surfaces.forEach((element) => { element.hidden = true; });
  const status = document.createElement('p'); status.className = 'preview-note'; status.setAttribute('role', 'status'); status.textContent = 'საიტი იტვირთება…'; document.body.prepend(status);
  try {
    const rows = await getContent();
    if (rows[0]) applyContent(document, rows[0].values);
    surfaces.forEach((element) => { element.hidden = false; }); status.remove();
  } catch (error) {
    if (error.status === 404) { surfaces.forEach((element) => { element.hidden = false; }); status.remove(); return; }
    status.textContent = 'საიტის შინაარსი დროებით მიუწვდომელია. ';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = 'ხელახლა ცდა'; retry.addEventListener('click', () => location.reload()); status.append(retry);
  }
}
