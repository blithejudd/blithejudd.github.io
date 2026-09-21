import { configured, preview, login, logout, restoreSession, listPhotos, photoUrl, savePhoto, uploadImage, removeImage, deletePhoto, changePassword, listCategories } from './api.js';
import { categories, setCategories, validatePhoto, validateImage } from './data.js';
import { prepareImage } from './images.js';
import { localizeForms } from './forms.js';
import { bindCms, loadCms, showEditorPage } from './cms-admin.js';
import { confirmAction } from './confirm.js';
import { bindConnections, loadConnections, clearConnections } from './connections-admin.js';

localizeForms();

const $ = (selector) => document.querySelector(selector);
const status = $('#admin-status');
let photos = [];
let queue = [];
let busy = false;
let pendingDelete = null;
const hasEdits = () => Boolean(document.querySelector('#workspace form[data-dirty="true"]'));
for (const name of ['input', 'change']) $('#workspace').addEventListener(name, (event) => {
  const form = event.target.closest('form');
  if (form && form.id !== 'password-form') { form.dataset.dirty = 'true'; $('#unsaved-status').hidden = false; }
});
$('#preview-notice').hidden = !preview;
if (preview) {
  $('.account-settings').hidden = true;
  fetch('/preview-api/demo-access').then((response) => { if (!response.ok) throw new Error(); return response.json(); }).then((access) => {
    $('#login-form [name=email]').value = access.email; $('#login-form [name=password]').value = access.password;
  }).catch(() => message('დემოს შესვლის მონაცემები ვერ ჩაიტვირთა.', true));
}

function message(text, error = false) {
  for (const element of [status, $('#workspace-feedback')]) { element.textContent = text; element.classList.toggle('error', error); }
  status.hidden = !$('#workspace').hidden;
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('#workspace button, #workspace input, #workspace select, #workspace textarea').forEach((control) => { control.disabled = value; });
  $('#upload-submit').disabled = value || queue.length === 0;
  $('#unsaved-status').hidden = !hasEdits();
}
function showTab(panel, page) {
  panel = panel === true ? 'upload' : panel === false ? 'photos' : panel;
  for (const name of ['photos', 'upload', 'content', 'categories', 'connections']) {
    $(`#${name}-panel`).hidden = name !== panel;
    $(`#tab-${name}`).setAttribute('aria-pressed', String(name === panel));
  }
  document.querySelectorAll('[data-editor-page]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
  if (panel === 'content') showEditorPage(page);
  $('#admin-navigation').value = document.querySelector('.admin-tabs button[aria-pressed="true"]')?.id.replace('tab-', '') || panel;
  history.replaceState(null, '', `#${$('#admin-navigation').value}`);
}

function updateCategories(rows) {
  setCategories(rows);
  document.querySelectorAll('#photo-library select[name=category], #upload-queue select[name=category]').forEach((select) => {
    const value = select.value; select.replaceChildren();
    Object.entries(categories).forEach(([id, name]) => { const option = document.createElement('option'); option.value = id; option.textContent = name; select.append(option); });
    if (!Object.hasOwn(categories, value)) { const option = document.createElement('option'); option.value = value; option.textContent = 'კატეგორია წაშლილია — აირჩიეთ სხვა'; select.append(option); }
    select.value = value;
  });
}
bindCms({ setBusy, message, categoriesChanged: updateCategories, openEditor: (page) => showTab('content', page) });
bindConnections({ setBusy, message });
document.querySelectorAll('[data-editor-page]').forEach((button) => button.addEventListener('click', () => showTab('content', button.dataset.editorPage)));
$('#admin-navigation').addEventListener('change', (event) => $(`#tab-${event.target.value}`).click());
$('#tab-categories').addEventListener('click', () => showTab('categories'));
$('#tab-connections').addEventListener('click', () => showTab('connections'));

function field(labelText, name, value, type = 'text') {
  const label = document.createElement('label'); label.textContent = labelText;
  const input = document.createElement('input'); input.type = type; input.name = name;
  if (type === 'checkbox') { input.checked = Boolean(value); label.className = 'checkbox'; label.prepend(input); }
  else { input.value = value; input.required = true; label.append(input); }
  if (name === 'title') input.maxLength = 160;
  if (name === 'alt') input.maxLength = 300;
  if (name === 'sort_order') { input.min = '0'; input.max = '1000000'; input.step = '1'; }
  return label;
}

function editor(photo, src, isQueue = false) {
  const card = document.createElement(isQueue ? 'div' : 'form'); card.className = 'editor-card';
  const image = document.createElement('img'); image.src = src; image.alt = photo.alt; image.loading = 'lazy'; card.append(image);
  card.append(field('სათაური საიტზე', 'title', photo.title), field('ფოტოს აღწერა (ხელმისაწვდომობისთვის)', 'alt', photo.alt));
  const label = document.createElement('label'); label.textContent = 'კატეგორია';
  const select = document.createElement('select'); select.name = 'category';
  Object.entries(categories).forEach(([value, title]) => { const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option); });
  select.value = photo.category; label.append(select);
  card.append(label, field('თანმიმდევრობა გალერეაში', 'sort_order', photo.sort_order, 'number'), field('გამოქვეყნებულია საიტზე', 'published', photo.published, 'checkbox'));
  return card;
}

function valuesFrom(card) {
  const values = {};
  card.querySelectorAll('[name]').forEach((input) => { values[input.name] = input.type === 'checkbox' ? input.checked : input.value; });
  return validatePhoto(values);
}

function button(text, action, className = 'button secondary') {
  const element = document.createElement('button'); element.type = 'button'; element.className = className; element.textContent = text; element.addEventListener('click', action); return element;
}

function renderLibrary(reset = false) {
  const library = $('#photo-library');
  // Keep other editors intact, including incomplete or invalid unsaved fields.
  const cards = new Map(reset ? [] : Array.from(library.children, (card) => [card.dataset.photoId, card]));
  library.replaceChildren(); $('#admin-count').textContent = photos.length;
  if (!photos.length) { const empty = document.createElement('p'); empty.textContent = 'აქ ჯერ ფოტოები არ არის. დაამატეთ პირველი ისტორია.'; library.append(empty); }
  photos.forEach((photo) => {
    if (cards.has(photo.id)) { library.append(cards.get(photo.id)); return; }
    const card = editor(photo, photoUrl(photo));
    card.dataset.photoId = photo.id;
    const replace = document.createElement('label'); replace.className = 'file-picker'; replace.textContent = 'ფოტოს შეცვლა';
    const replacement = document.createElement('input'); replacement.type = 'file'; replacement.accept = 'image/jpeg,image/png,image/webp'; replace.append(replacement); card.append(replace);
    const info = document.createElement('p'); info.className = 'file-info'; info.textContent = photo.source === 'local' ? 'საწყისი ფოტო რეპოზიტორიიდან' : 'ფოტო Supabase საცავში'; card.append(info);
    const actions = document.createElement('div'); actions.className = 'editor-actions';
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'button'; save.textContent = 'შენახვა';
    actions.append(save, button('წაშლა', () => { pendingDelete = photo; $('#delete-title').textContent = photo.title; $('#delete-dialog').showModal(); }));
    card.append(actions); library.append(card);
    card.addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy) return;
      let values;
      try { values = valuesFrom(card); } catch (error) { message(error.message, true); return; }
      setBusy(true);
      message('ცვლილებები ინახება…');
      try {
        if (replacement.files[0]) {
          values.image_path = await uploadImage(await prepareImage(replacement.files[0])); values.source = 'storage';
        }
        const saved = await savePhoto(photo.id, values);
        photos = photos.map((item) => item.id === photo.id ? saved : item).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
        card.remove();
        renderLibrary(); message('ცვლილებები შენახულია. საიტზე გამოჩნდება გვერდის განახლების შემდეგ.');
      } catch (error) { message(error.message, true); }
      finally { setBusy(false); }
    });
  });
}

async function loadLibrary() {
  try { updateCategories(await listCategories(true)); } catch (error) { if (error.status !== 404) throw error; }
  photos = await listPhotos(true); renderLibrary(true);
}

function clearQueue() {
  queue.forEach((item) => URL.revokeObjectURL(item.url)); queue = []; $('#upload-queue').replaceChildren();
  $('#file-input').value = ''; $('#clear-queue').hidden = true; $('#upload-submit').disabled = true;
  $('#upload-form').dataset.dirty = 'false';
  $('#unsaved-status').hidden = !hasEdits();
}

async function addFiles(files) {
  if (busy || !files.length) return;
  setBusy(true);
  const errors = [];
  for (const file of files) {
    message(`მომზადება: ${file.name}`);
    try {
      validateImage(file);
      const title = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || 'ფოტო';
      const photo = { title, alt: title, category: Object.keys(categories)[0] || '', sort_order: Math.min(1000000, photos.reduce((max, item) => Math.max(max, item.sort_order), 0) + (queue.length + 1) * 10), published: false };
      const url = URL.createObjectURL(file);
      const card = editor(photo, url, true);
      const item = { file, url, card, name: file.name }; queue.push(item);
      const info = document.createElement('p'); info.className = 'file-info'; info.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} კბ · WebP-ში გარდაიქმნება ატვირთვისას`; card.append(info);
      card.append(button('რიგიდან ამოღება', () => { queue = queue.filter((entry) => entry !== item); URL.revokeObjectURL(url); card.remove(); $('#upload-submit').disabled = queue.length === 0; $('#clear-queue').hidden = queue.length === 0; }));
      $('#upload-queue').append(card);
      setBusy(true);
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  setBusy(false); $('#file-input').value = ''; $('#clear-queue').hidden = queue.length === 0;
  message(errors.length ? errors.join('\n') : 'ფოტოები მზადაა. შეამოწმეთ წარწერები და დააჭირეთ „ფოტოების ატვირთვას“.', errors.length > 0);
}

$('#file-input').addEventListener('change', (event) => addFiles(Array.from(event.target.files)));
const dropZone = $('#drop-zone');
['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); if (!busy) dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (event) => addFiles(Array.from(event.dataTransfer.files)));
$('#clear-queue').addEventListener('click', clearQueue);
window.addEventListener('beforeunload', (event) => { if (busy || queue.length || hasEdits()) { event.preventDefault(); event.returnValue = ''; } });

$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy || !queue.length) return;
  let entries;
  try { entries = queue.map((item) => ({ item, values: valuesFrom(item.card) })); }
  catch (error) { message(error.message, true); return; }
  setBusy(true);
  let completed = 0;
  let failure = '';
  for (const { item, values } of entries) {
    message(`ატვირთვა ${completed + 1} / ${entries.length}: ${item.name}`);
    let path;
    try {
      path = await uploadImage(await prepareImage(item.file));
      const saved = await savePhoto(null, { ...values, image_path: path, source: 'storage' });
      photos.push(saved); queue = queue.filter((entry) => entry !== item); URL.revokeObjectURL(item.url); item.card.remove(); completed++;
    } catch (error) {
      failure = error.message;
      if (path) {
        // A timed-out insert may have committed. Keep the file rather than break a saved photo.
        // Only a definite rejected insert can safely be compensated.
        if (error.status && error.status >= 400 && error.status < 500) {
          try { await removeImage(path); } catch { failure += ` ფაილი დარჩა საცავში: ${path}`; }
        } else { failure += ` ხელახლა ცდამდე შეამოწმეთ სია: შესაძლოა, ჩანაწერი უკვე შენახულია. ფაილი: ${path}`; }
      }
      break;
    }
  }
  photos.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)); renderLibrary(); setBusy(false);
  $('#clear-queue').hidden = queue.length === 0;
  message(`ატვირთულია: ${completed} / ${entries.length}.${failure ? '\n' + failure : ' მზადაა.'}`, Boolean(failure));
  if (!queue.length) showTab(false);
  if (!queue.length) $('#upload-form').dataset.dirty = 'false';
});

$('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close());
$('#confirm-delete').addEventListener('click', async () => {
  if (busy || !pendingDelete) return;
  const photo = pendingDelete; $('#delete-dialog').close(); setBusy(true);
  try { const result = await deletePhoto(photo); photos = photos.filter((item) => item.id !== photo.id); renderLibrary(); message(result); }
  catch (error) { message(error.message, true); }
  finally { pendingDelete = null; setBusy(false); }
});
$('#tab-upload').addEventListener('click', () => showTab(true));
$('#tab-photos').addEventListener('click', () => showTab(false));
$('#refresh').addEventListener('click', async () => {
  if ($('#photo-library form[data-dirty="true"]') && !await confirmAction('განახლება წაშლის ფოტოების შეუნახავ ცვლილებებს. გაგრძელდეს?')) return;
  setBusy(true); try { await loadLibrary(); message('სია განახლებულია.'); } catch (error) { message(error.message, true); } finally { setBusy(false); }
});

async function openWorkspace() {
  $('#login-section').hidden = true; $('#workspace').hidden = false;
  if (preview) $('#preview-notice').textContent = 'ლოკალური დემო — ცვლილებები ნამდვილ საიტს არ ეხება.';
  setBusy(true);
  try {
    await loadLibrary();
    try { await loadCms(); } catch { $('#cms-notice').hidden = false; }
    await loadConnections();
    const requestedTab = document.getElementById(`tab-${location.hash.slice(1) || 'content'}`);
    if (requestedTab?.closest('.admin-tabs')) showTab(requestedTab.dataset.editorPage ? 'content' : requestedTab.id.replace('tab-', ''), requestedTab.dataset.editorPage);
    message('');
  }
  finally { setBusy(false); }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button'); if (submit.disabled) return;
  submit.disabled = true;
  const values = new FormData(event.currentTarget);
  try { await login(String(values.get('email')).trim(), String(values.get('password'))); $('#login-form').reset(); await openWorkspace(); }
  catch (error) { message(error.message, true); }
  finally { submit.disabled = false; }
});
$('#logout').addEventListener('click', () => {
  if (queue.length || hasEdits()) $('#logout-dialog').showModal();
  else closeWorkspace();
});
$('#cancel-logout').addEventListener('click', () => $('#logout-dialog').close());
$('#confirm-logout').addEventListener('click', () => { $('#logout-dialog').close(); closeWorkspace(); });
async function closeWorkspace() {
  setBusy(true);
  try { await logout(); message('პანელიდან გახვედით.'); }
  catch { message('ამ ჩანართში შესვლა გასუფთავებულია. სერვერმა გასვლის მოთხოვნას არ უპასუხა; საჭიროების შემთხვევაში დაასრულეთ სესიები Supabase-ში.', true); }
  finally { clearQueue(); clearConnections(); photos = []; $('#password-form').reset(); $('#password-status').textContent = ''; $('#photo-library').replaceChildren(); $('#workspace').querySelectorAll('form').forEach((form) => { form.dataset.dirty = 'false'; }); $('#workspace').hidden = true; $('#login-section').hidden = false; setBusy(false); }
}

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const values = new FormData(form);
  const result = $('#password-status');
  result.classList.remove('error');
  if (values.get('new_password') !== values.get('confirm_password')) {
    result.textContent = 'პაროლები არ ემთხვევა.'; result.classList.add('error'); return;
  }
  setBusy(true); result.textContent = 'პაროლი იცვლება…';
  try {
    await changePassword(String(values.get('current_password')), String(values.get('new_password')));
    form.reset(); result.textContent = 'პაროლი შეცვლილია. შემდეგი შესვლისას გამოიყენეთ ახალი პაროლი.';
  } catch (error) { result.textContent = error.message; result.classList.add('error'); }
  finally { setBusy(false); }
});

if (!configured) {
  $('#setup').hidden = false;
  $('#login-form').querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
} else {
  try { if (await restoreSession()) await openWorkspace(); }
  catch (error) { message(error.message, true); }
}
