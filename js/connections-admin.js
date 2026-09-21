import { preview, publicConfig, connectionStatus, saveConnections, testTelegram, checkPublicConnection } from './api.js';
import { validateTelegram } from './connections-validation.js';

const $ = (selector) => document.querySelector(selector);
let state = null, callbacks, downloadUrl;

function displayStatus(value) {
  state = value;
  $('#telegram-state').textContent = `ტოკენი: ${value.tokenConfigured ? 'დაყენებულია' : 'არ არის დაყენებული'} · ჩატი: ${value.chatConfigured ? 'დაყენებულია' : 'არ არის დაყენებული'} · ჰეშის საიდუმლო: ${value.saltConfigured ? 'დაყენებულია' : 'არ არის დაყენებული'} · მიღება: ${value.enabled ? 'ჩართულია' : 'გამორთულია'}`;
  const form = $('#telegram-settings');
  form.elements.enabled.checked = value.enabled;
  form.elements.origins.value = value.allowedOrigins.join('\n');
  form.dataset.dirty = 'false';
}

function clearSecrets(form) {
  for (const name of ['bot_token', 'chat_id', 'hash_salt']) form.elements[name].value = '';
}

export function bindConnections(actions) {
  callbacks = actions;
  const config = publicConfig();
  $('#active-supabase-url').textContent = config.supabaseUrl;
  $('#supabase-settings [name=url]').value = preview ? 'https://example.supabase.co' : config.supabaseUrl;
  $('#supabase-settings [name=key]').value = preview ? 'sb_publishable_demo' : config.supabaseKey;
  $('#connections-demo').hidden = !preview;
  $('#telegram-settings').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    if (!state) { callbacks.message('ჯერ გამოიყენეთ კავშირების მიგრაცია და განაახლეთ გვერდი.', true); clearSecrets(form); return; }
    let values;
    try { values = validateTelegram({ bot_token: form.elements.bot_token.value, chat_id: form.elements.chat_id.value, hash_salt: form.elements.hash_salt.value, origins: form.elements.origins.value, enabled: form.elements.enabled.checked }, preview); }
    catch (error) { callbacks.message(error.message, true); clearSecrets(form); return; }
    try {
      callbacks.setBusy(true); callbacks.message('კავშირის პარამეტრები ინახება…');
      displayStatus(await saveConnections({ ...values, p_revision: state.revision }));
      callbacks.message('პარამეტრები შენახულია. კავშირი ავტომატურად არ შემოწმებულა; შეტყობინება არ გაგზავნილა.');
    } catch { callbacks.message('პარამეტრები ვერ შეინახა. შეამოწმეთ ფორმატი, ველები და მიგრაცია; თუ სხვა ჩანართში შეცვალეთ, განაახლეთ გვერდი. მოქმედი მონაცემები არ წაშლილა.', true); }
    finally { clearSecrets(form); callbacks.setBusy(false); }
  });
  $('#telegram-check').addEventListener('click', async () => {
    if (!state || $('#telegram-settings').dataset.dirty === 'true') { callbacks.message('შემოწმებამდე შეინახეთ პარამეტრები.', true); return; }
    callbacks.setBusy(true); callbacks.message('Telegram კავშირი მოწმდება…');
    try {
      const result = await testTelegram();
      if (result.botValid !== true || result.chatReachable !== true) throw new Error();
      callbacks.message(result.simulated ? 'დემო შემოწმება წარმატებულია. Telegram-თან რეალური კავშირი არ შესრულებულა.' : 'ტოკენი და ჩატი ხელმისაწვდომია. შემოწმებამ შეტყობინება არ გაგზავნა.');
    } catch { callbacks.message('კავშირი ვერ დადასტურდა. შეამოწმეთ შენახული ტოკენი, ჩატი, ნებადართული მისამართები და სერვერული ფუნქცია.', true); }
    finally { callbacks.setBusy(false); }
  });
  const form = $('#supabase-settings');
  form.addEventListener('input', () => { $('#config-download').hidden = true; if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); callbacks.setBusy(true); callbacks.message('ახალი საჯარო კავშირი მოწმდება…');
    try {
      const result = await checkPublicConnection(form.elements.url.value, form.elements.key.value, form.elements.email.value.trim(), form.elements.password.value);
      const config = { supabaseUrl: result.supabaseUrl, supabaseKey: result.supabaseKey, contactEnabled: false };
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([`// Public configuration only.\nexport const config = Object.freeze(${JSON.stringify(config, null, 2)});\n`], { type: 'text/javascript' }));
      const link = $('#config-download'); link.href = downloadUrl; link.hidden = false;
      form.dataset.dirty = 'false';
      callbacks.message(result.simulated ? 'დემოში მომზადებულია საცდელი ფაილი; რეალური Supabase არ შემოწმებულა. მოქმედი კავშირი არ შეცვლილა.' : 'კავშირი და მფლობელის წვდომა დადასტურებულია. ჩამოტვირთეთ ფაილი და განათავსეთ js/config.js-ის ნაცვლად. მოქმედი კავშირი შეიცვლება მხოლოდ საიტის გამოქვეყნებისას.');
    } catch (error) { callbacks.message(error.message, true); }
    finally { form.elements.password.value = ''; callbacks.setBusy(false); }
  });
}

export async function loadConnections() {
  state = null;
  clearSecrets($('#telegram-settings'));
  $('#supabase-settings [name=password]').value = '';
  $('#config-download').hidden = true;
  try { displayStatus(await connectionStatus()); $('#connections-notice').hidden = true; }
  catch { $('#connections-notice').hidden = false; $('#telegram-state').textContent = 'კავშირების მდგომარეობა ვერ ჩაიტვირთა.'; }
}

export function clearConnections() {
  clearSecrets($('#telegram-settings'));
  $('#supabase-settings [name=password]').value = '';
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null; $('#config-download').hidden = true;
}
