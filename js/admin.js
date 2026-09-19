import { configured, login, logout, restoreSession, listPhotos, photoUrl, savePhoto, uploadImage, removeImage, deletePhoto, changePassword } from './api.js';
import { categoryNamesRu, validatePhoto } from './data.js';
import { prepareImage } from './images.js';

const $ = (selector) => document.querySelector(selector);
const status = $('#admin-status');
let photos = [];
let queue = [];
let busy = false;
let pendingDelete = null;

function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function setBusy(value) {
  busy = value;
  document.querySelectorAll('#workspace button, #workspace input, #workspace select').forEach((control) => { control.disabled = value; });
  $('#upload-submit').disabled = value || queue.length === 0;
}
function showTab(upload) {
  $('#upload-panel').hidden = !upload; $('#photos-panel').hidden = upload;
  $('#tab-upload').setAttribute('aria-pressed', String(upload)); $('#tab-photos').setAttribute('aria-pressed', String(!upload));
}

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
  card.append(field('Название на сайте', 'title', photo.title), field('Описание фото (для доступности)', 'alt', photo.alt));
  const label = document.createElement('label'); label.textContent = 'Категория';
  const select = document.createElement('select'); select.name = 'category';
  Object.entries(categoryNamesRu).forEach(([value, title]) => { const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option); });
  select.value = photo.category; label.append(select);
  card.append(label, field('Порядок в галерее', 'sort_order', photo.sort_order, 'number'), field('Опубликовано на сайте', 'published', photo.published, 'checkbox'));
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

function renderLibrary() {
  const library = $('#photo-library'); library.replaceChildren(); $('#admin-count').textContent = photos.length;
  if (!photos.length) { const empty = document.createElement('p'); empty.textContent = 'Здесь пока нет фотографий. Добавьте первую историю.'; library.append(empty); }
  photos.forEach((photo) => {
    const card = editor(photo, photoUrl(photo));
    const info = document.createElement('p'); info.className = 'file-info'; info.textContent = photo.source === 'local' ? 'Исходное фото из репозитория' : 'Фото в Supabase Storage'; card.append(info);
    const actions = document.createElement('div'); actions.className = 'editor-actions';
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'button'; save.textContent = 'Сохранить';
    actions.append(save, button('Удалить', () => { pendingDelete = photo; $('#delete-title').textContent = photo.title; $('#delete-dialog').showModal(); }));
    card.append(actions); library.append(card);
    card.addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy) return;
      let values;
      try { values = valuesFrom(card); } catch (error) { message(error.message, true); return; }
      setBusy(true);
      try {
        const saved = await savePhoto(photo.id, values);
        photos = photos.map((item) => item.id === photo.id ? saved : item).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
        renderLibrary(); message('Изменения сохранены. На сайте они появятся после обновления страницы.');
      } catch (error) { message(error.message, true); }
      finally { setBusy(false); }
    });
  });
}

async function loadLibrary() { photos = await listPhotos(true); renderLibrary(); }

function clearQueue() {
  queue.forEach((item) => URL.revokeObjectURL(item.url)); queue = []; $('#upload-queue').replaceChildren();
  $('#file-input').value = ''; $('#clear-queue').hidden = true; $('#upload-submit').disabled = true;
}

async function addFiles(files) {
  if (busy || !files.length) return;
  if (queue.length + files.length > 12) { message('Выберите не больше 12 фото за одну загрузку.', true); return; }
  setBusy(true);
  const errors = [];
  for (const file of files) {
    message(`Подготовка: ${file.name}`);
    try {
      const blob = await prepareImage(file);
      const title = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || 'ფოტო';
      const photo = { title, alt: title, category: 'portraits', sort_order: Math.min(1000000, Math.max(0, ...photos.map((item) => item.sort_order)) + (queue.length + 1) * 10), published: false };
      const url = URL.createObjectURL(blob);
      const card = editor(photo, url, true);
      const item = { blob, url, card, name: file.name }; queue.push(item);
      const info = document.createElement('p'); info.className = 'file-info'; info.textContent = `${file.name} → ${(blob.size / 1024).toFixed(0)} КБ, WebP`; card.append(info);
      card.append(button('Убрать из очереди', () => { queue = queue.filter((entry) => entry !== item); URL.revokeObjectURL(url); card.remove(); $('#upload-submit').disabled = queue.length === 0; $('#clear-queue').hidden = queue.length === 0; }));
      $('#upload-queue').append(card);
      setBusy(true);
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  setBusy(false); $('#file-input').value = ''; $('#clear-queue').hidden = queue.length === 0;
  message(errors.length ? errors.join('\n') : 'Фото подготовлены. Проверьте подписи и нажмите «Загрузить фотографии».', errors.length > 0);
}

$('#file-input').addEventListener('change', (event) => addFiles(Array.from(event.target.files)));
const dropZone = $('#drop-zone');
['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); if (!busy) dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (event) => addFiles(Array.from(event.dataTransfer.files)));
$('#clear-queue').addEventListener('click', clearQueue);
window.addEventListener('beforeunload', (event) => { if (busy || queue.length) { event.preventDefault(); event.returnValue = ''; } });

$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy || !queue.length) return;
  let entries;
  try { entries = queue.map((item) => ({ item, values: valuesFrom(item.card) })); }
  catch (error) { message(error.message, true); return; }
  setBusy(true);
  let completed = 0;
  let failure = '';
  for (const { item, values } of entries) {
    message(`Загрузка ${completed + 1} / ${entries.length}: ${item.name}`);
    let path;
    try {
      path = await uploadImage(item.blob);
      const saved = await savePhoto(null, { ...values, image_path: path, source: 'storage' });
      photos.push(saved); queue = queue.filter((entry) => entry !== item); URL.revokeObjectURL(item.url); item.card.remove(); completed++;
    } catch (error) {
      failure = error.message;
      if (path) {
        // A timed-out insert may have committed. Keep the file rather than break a saved photo.
        // Only a definite rejected insert can safely be compensated.
        if (error.status && error.status >= 400 && error.status < 500) {
          try { await removeImage(path); } catch { failure += ` Файл остался в Storage: ${path}`; }
        } else { failure += ` Проверьте список перед повтором: сервер мог сохранить запись. Файл: ${path}`; }
      }
      break;
    }
  }
  photos.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)); renderLibrary(); setBusy(false);
  $('#clear-queue').hidden = queue.length === 0;
  message(`Загружено: ${completed} из ${entries.length}.${failure ? '\n' + failure : ' Готово.'}`, Boolean(failure));
  if (!queue.length) showTab(false);
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
  setBusy(true); try { await loadLibrary(); message('Список обновлён.'); } catch (error) { message(error.message, true); } finally { setBusy(false); }
});

async function openWorkspace() {
  $('#login-section').hidden = true; $('#workspace').hidden = false;
  setBusy(true);
  try { await loadLibrary(); message('Вы вошли. Можно обновлять портфолио.'); }
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
$('#logout').addEventListener('click', async () => {
  if (queue.length && !confirm('Выйти? Подготовленные, но не загруженные фото будут убраны из очереди.')) return;
  setBusy(true);
  try { await logout(); message('Вы вышли из панели.'); }
  catch { message('Вход в этой вкладке очищен. Сервер не ответил на запрос выхода; при необходимости завершите сессии в Supabase.', true); }
  finally { clearQueue(); photos = []; $('#password-form').reset(); $('#password-status').textContent = ''; $('#photo-library').replaceChildren(); $('#workspace').hidden = true; $('#login-section').hidden = false; setBusy(false); }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const values = new FormData(form);
  const result = $('#password-status');
  result.classList.remove('error');
  if (values.get('new_password') !== values.get('confirm_password')) {
    result.textContent = 'Пароли не совпадают.'; result.classList.add('error'); return;
  }
  setBusy(true); result.textContent = 'Меняем пароль…';
  try {
    await changePassword(String(values.get('current_password')), String(values.get('new_password')));
    form.reset(); result.textContent = 'Пароль изменён. При следующем входе используйте новый пароль.';
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