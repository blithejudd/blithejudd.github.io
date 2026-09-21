import { getContent, saveContent, listCategories, saveCategory, deleteCategory, uploadImage, photoUrl } from './api.js';
import { contentFields, validateContent, applyContent } from './content.js';
import { editorPages, editorField } from './cms-fields.js';
import { prepareImage } from './images.js';
import { confirmAction } from './confirm.js';

const $ = (selector) => document.querySelector(selector);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
let contentRows, fields, currentValues, stagedImages;
let actions, activePage = 'hero';

export function showEditorPage(page = activePage) {
  activePage = page;
  $('#content-title').textContent = editorPages[page][0];
  $('#content-description').textContent = editorPages[page][1];
  $('#content-search').value = '';
  $('#content-form').querySelectorAll('[data-section]').forEach((section) => { section.hidden = section.dataset.section !== page; });
  $('#content-form').querySelectorAll('.content-field, .editor-group').forEach((element) => { element.hidden = false; });
  document.querySelectorAll('[data-editor-page]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.editorPage === page && !$('#content-panel').hidden)));
}

function draftStatus() {
  $('#content-state').textContent = $('#content-form').dataset.dirty === 'true' ? 'შეუნახავი ცვლილებები' : JSON.stringify(contentRows?.draft.values) === JSON.stringify(contentRows?.published.values) ? 'ყველა ცვლილება გამოქვეყნებულია' : 'მონახაზი ჯერ არ გამოქვეყნებულა';
}

function control(label, name, value, type = 'text') {
  const wrapper = node('label', label);
  const input = node(type === 'textarea' ? 'textarea' : 'input'); input.name = name;
  if (type !== 'textarea') input.type = type;
  if (type === 'checkbox') { wrapper.className = 'checkbox'; input.checked = value; wrapper.prepend(input); }
  else { input.value = value; wrapper.append(input); }
  if (type === 'textarea') { input.rows = 2; input.maxLength = 5000; }
  return { wrapper, input };
}

function renderContent() {
  const form = $('#content-form');
  form.querySelectorAll('[data-preview-url]').forEach((image) => URL.revokeObjectURL(image.dataset.previewUrl));
  form.replaceChildren();
  const pages = new Map(), groups = new Map();
  for (const [key] of Object.entries(editorPages)) {
    const section = node('section', null, 'editor-page'); section.dataset.section = key;
    pages.set(key, section); form.append(section);
  }
  fields.slice().sort((a, b) => editorField(a).rank - editorField(b).rank).forEach((field) => {
    const meta = editorField(field), groupKey = `${meta.page}:${meta.card}`;
    if (!groups.has(groupKey)) {
      const card = node('section', null, 'editor-group'); card.append(node('h3', meta.card));
      const grid = node('div', null, 'editor-grid'); card.append(grid);
      pages.get(meta.page).append(card); groups.set(groupKey, grid);
    }
    const value = currentValues[field.key] ?? field.value;
    let wrapper, input;
    if (field.type === 'image') {
      wrapper = node('div', null, 'content-image'); wrapper.append(node('p', meta.label));
      const image = node('img'); image.src = photoUrl(value); image.alt = meta.label; wrapper.append(image);
      const picker = control('ფოტოს შეცვლა — JPG, PNG, WebP', field.key, '', 'file'); input = picker.input;
      input.accept = 'image/jpeg,image/png,image/webp'; picker.wrapper.className = 'file-picker'; wrapper.append(picker.wrapper);
      input.addEventListener('change', () => {
        if (image.dataset.previewUrl) URL.revokeObjectURL(image.dataset.previewUrl);
        if (input.files[0]) { image.dataset.previewUrl = URL.createObjectURL(input.files[0]); image.src = image.dataset.previewUrl; }
      });
    } else {
      const multiline = [5,7,29,41,60,61,62,73,97,110].includes(Number(field.key.slice(1,4))) || typeof value === 'string' && /[\r\n]/.test(value);
      ({ wrapper, input } = control(meta.label, field.key, value, field.type === 'boolean' ? 'checkbox' : ['order', 'position'].includes(field.type) ? 'number' : field.type === 'phone' ? 'tel' : field.type === 'link' ? 'url' : multiline ? 'textarea' : 'text'));
      if (['text', 'tel', 'url'].includes(input.type)) input.maxLength = 5000;
      if (input.type === 'number') { input.min = 0; input.max = field.type === 'position' ? 100 : 1000000; input.step = 1; input.required = true; }
      if (field.type === 'link') input.required = true;
    }
    input.id = `cms-${field.key.replaceAll('.', '-')}`;
    input.addEventListener('input', () => input.setCustomValidity(''));
    if (meta.placeholder) input.placeholder = meta.placeholder;
    if (meta.help) { const help = node('small', meta.help, 'field-help'); help.id = `${input.id}-help`; input.setAttribute('aria-describedby', help.id); wrapper.append(help); }
    wrapper.classList.add('content-field'); wrapper.dataset.search = `${meta.label} ${typeof value === 'string' ? value : ''}`.toLowerCase();
    if (field.type === 'image' || [29,60,61,62,97,110].includes(Number(field.key.slice(1,4)))) wrapper.classList.add('field-wide');
    groups.get(groupKey).append(wrapper);
  });
  form.dataset.dirty = 'false';
  showEditorPage(); draftStatus();
}

async function saveDraft() {
  const form = $('#content-form');
  const values = { ...currentValues };
  for (const field of fields) {
    const input = form.elements.namedItem(field.key);
    if (field.type !== 'image') values[field.key] = field.type === 'boolean' ? input.checked : ['order', 'position'].includes(field.type) ? input.value.trim() ? Number(input.value) : NaN : input.value;
  }
  for (const field of fields) {
    try { validateContent([field], values); }
    catch (error) {
      const input = form.elements.namedItem(field.key);
      actions.openEditor(editorField(field).page);
      actions.setBusy(false);
      input.dataset.cmsError = error.message;
      input.setCustomValidity(error.message); input.reportValidity();
      throw error;
    }
  }
  for (const field of fields.filter((item) => item.type === 'image')) {
    const input = form.elements.namedItem(field.key);
    const file = input.files[0];
    if (!file) continue;
    let staged = stagedImages.get(field.key);
    if (!staged || staged.file !== file) {
      actions.message('ფოტო იტვირთება…');
      staged = { file, value: { source: 'storage', image_path: await uploadImage(await prepareImage(file)) } };
      stagedImages.set(field.key, staged);
    }
    values[field.key] = staged.value;
  }
  const saved = await saveContent('draft', validateContent(fields, values), contentRows.draft.revision);
  contentRows.draft = saved; currentValues = saved.values;
  form.querySelectorAll('input[type=file]').forEach((input) => { input.value = ''; });
  stagedImages.clear(); form.dataset.dirty = 'false'; draftStatus();
  return saved;
}

async function run(action) {
  if ($('#content-save').disabled) return;
  if (!contentRows?.draft) { actions.message('ჯერ გამოიყენეთ შინაარსის მართვის მიგრაცია და განაახლეთ გვერდი.', true); return; }
  actions.setBusy(true);
  actions.message('ცვლილებები ინახება…');
  try { await action(); } catch (error) { actions.message(error.message, true); }
  finally { actions.setBusy(false); }
}

async function categoriesChanged() {
  const rows = await listCategories(true);
  actions.categoriesChanged(rows);
  const list = $('#category-list');
  const cards = new Map([...list.children].map((card) => [card.dataset.categoryId, card]));
  rows.forEach((row) => { if (cards.has(row.id)) list.append(cards.get(row.id)); });
  return rows;
}

function categoryCard(row) {
  const form = node('form', null, 'category-card'); form.dataset.categoryId = row.id;
  const name = control('კატეგორიის სახელი', 'name', row.name); name.input.required = true; name.input.maxLength = 100;
  const order = control('თანმიმდევრობა', 'sort_order', row.sort_order, 'number'); order.input.required = true; order.input.min = 0; order.input.max = 1000000; order.input.step = 1;
  const visible = control('გამოჩნდეს საიტზე', 'visible', row.visible, 'checkbox');
  const buttons = node('div', null, 'editor-actions');
  const save = node('button', 'შენახვა', 'button'); save.type = 'submit';
  const remove = node('button', 'წაშლა', 'button secondary'); remove.type = 'button'; buttons.append(save, remove);
  form.append(name.wrapper, order.wrapper, visible.wrapper, buttons);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); run(async () => {
      await saveCategory(row.id, { name: name.input.value.trim(), sort_order: Number(order.input.value), visible: visible.input.checked });
      form.dataset.dirty = 'false'; await categoriesChanged(); actions.message('კატეგორია შენახულია. ცვლილება საიტზე გამოჩნდება განახლების შემდეგ.');
    });
  });
  remove.addEventListener('click', async () => {
    if (!await confirmAction('წაიშალოს კატეგორია? თუ მას ფოტოები აქვს, ჯერ გადაიტანეთ ისინი სხვა კატეგორიაში.')) return;
    run(async () => { await deleteCategory(row.id); form.remove(); await categoriesChanged(); actions.message('კატეგორია წაშლილია.'); });
  });
  return form;
}

export function bindCms(callbacks) {
  actions = callbacks;
  $('#content-form').addEventListener('input', () => { $('#content-form').dataset.dirty = 'true'; draftStatus(); });
  $('#content-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => { await saveDraft(); actions.message('მონახაზი შენახულია. სტუმრები მას ჯერ ვერ ხედავენ.'); }); });
  $('#content-save').addEventListener('click', () => run(async () => { await saveDraft(); actions.message('მონახაზი შენახულია. სტუმრები მას ჯერ ვერ ხედავენ.'); }));
  $('#content-revert').addEventListener('click', async () => {
    if (!await confirmAction('მონახაზი ჩანაცვლდეს გამოქვეყნებული ვერსიით? მიმდინარე შეუნახავი ცვლილებები დაიკარგება.')) return;
    run(async () => {
      const saved = await saveContent('draft', contentRows.published.values, contentRows.draft.revision);
      contentRows.draft = saved;
      currentValues = { ...Object.fromEntries(fields.map((field) => [field.key, field.value])), ...saved.values };
      stagedImages.clear(); renderContent(); actions.message('მონახაზი აღდგენილია გამოქვეყნებული ვერსიიდან.');
    });
  });
  $('#content-publish').addEventListener('click', async () => {
    if (!await confirmAction('გამოქვეყნდეს ტექსტები, სურათები და განყოფილებების პარამეტრები?')) return;
    run(async () => {
      await saveDraft();
      contentRows.published = await saveContent('published', currentValues, contentRows.published.revision);
      draftStatus();
      actions.message('საიტის შინაარსი გამოქვეყნებულია. განაახლეთ საიტის გვერდი.');
    });
  });
  $('#content-preview').addEventListener('click', () => run(async () => {
    await saveDraft();
    const dialog = $('#content-preview-dialog'); const frame = dialog.querySelector('iframe');
    frame.onload = () => { applyContent(frame.contentDocument, currentValues); };
    frame.src = '../?draft-preview=1'; dialog.showModal(); actions.message('მონახაზი შენახულია და გახსნილია წინასწარი ნახვა.');
  }));
  $('#close-content-preview').addEventListener('click', () => $('#content-preview-dialog').close());
  $('#content-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    $('#content-form').querySelectorAll(`[data-section="${activePage}"] .editor-group`).forEach((section) => {
      section.querySelectorAll('.content-field').forEach((field) => { field.hidden = Boolean(query) && !field.dataset.search.includes(query); });
      section.hidden = !section.querySelector('.content-field:not([hidden])');
    });
  });
  $('#category-create').addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.currentTarget;
    run(async () => {
      const row = await saveCategory(`c-${crypto.randomUUID()}`, { name: form.elements.name.value.trim(), sort_order: Number(form.elements.sort_order.value), visible: true }, true);
      $('#category-list').append(categoryCard(row)); form.reset(); form.dataset.dirty = 'false'; await categoriesChanged(); actions.message('ახალი კატეგორია დამატებულია.');
    });
  });
}

export async function loadCms() {
  contentRows = null;
  const [rows, response] = await Promise.all([getContent(true), fetch('../index.html', { cache: 'no-store' })]);
  if (!response.ok) throw new Error('საიტის შაბლონი ვერ ჩაიტვირთა.');
  contentRows = Object.fromEntries(rows.map((row) => [row.id, row]));
  if (!contentRows.draft || !contentRows.published) throw new Error('ჯერ გამოიყენეთ შინაარსის მართვის მიგრაცია.');
  const template = new DOMParser().parseFromString(await response.text(), 'text/html');
  fields = contentFields(template); stagedImages = new Map();
  currentValues = { ...Object.fromEntries(fields.map((field) => [field.key, field.value])), ...contentRows.draft.values };
  renderContent();
  const categories = await categoriesChanged(); $('#category-list').replaceChildren(...categories.map(categoryCard));
  $('#cms-notice').hidden = true;
}
