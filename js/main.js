import { initGallery } from './gallery.js';
import { configured, sendContact, contactEnabled, loadConnectionSettings } from './api.js';
import { contactDate, localizeForms } from './forms.js';
import { initContent } from './content.js';

localizeForms();
initContent();

const menu = document.querySelector('#navigation');
const toggle = document.querySelector('#menu-toggle');
function closeMenu() { menu.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); }
toggle.addEventListener('click', () => {
  const open = menu.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', String(open));
});
menu.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.classList.contains('is-open')) { closeMenu(); toggle.focus(); } });
document.addEventListener('click', (event) => { if (!event.target.closest('.site-header')) closeMenu(); });
matchMedia('(min-width: 701px)').addEventListener('change', closeMenu);
document.querySelector('#year').textContent = new Date().getFullYear();
initGallery();

const form = document.querySelector('#contact-form');
const submit = document.querySelector('#contact-submit');
const status = document.querySelector('#contact-status');
loadConnectionSettings().then((enabled) => { submit.disabled = !enabled; if (enabled) status.textContent = ''; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!configured || !contactEnabled || submit.disabled) return;
  submit.disabled = true; status.textContent = 'იგზავნება…';
  try {
    const values = Object.fromEntries(new FormData(form));
    values.date = contactDate(values.date);
    const result = await sendContact(values);
    form.reset(); status.textContent = result?.simulated ? 'დემო მოთხოვნა მიღებულია. რეალური შეტყობინება არ გაგზავნილა.' : 'გმადლობთ! თქვენი მოთხოვნა მიღებულია. მალე დაგიკავშირდებით.';
  } catch {
    status.textContent = 'გაგზავნა ვერ მოხერხდა. სცადეთ მოგვიანებით ან მომწერეთ ინსტაგრამზე.';
  } finally { submit.disabled = false; }
});
