export function validateTelegram(values, demo = false) {
  const token = values.bot_token.trim(), chat = values.chat_id.trim(), salt = values.hash_salt.trim();
  if (demo) {
    if ((token && token !== 'demo-bot-token') || (chat && chat !== 'demo-chat-id') || (salt && salt !== 'demo-hash-salt')) throw new Error('დემოში გამოიყენეთ მხოლოდ მითითებული საცდელი მნიშვნელობები. ნამდვილი საიდუმლოებები არ შეიყვანოთ.');
  } else {
    if (token && !/^[0-9]{5,20}:[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error('Telegram-ის ტოკენის ფორმატი არასწორია.');
    if (chat && !/^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chat)) throw new Error('Telegram-ის ჩატის იდენტიფიკატორი არასწორია.');
    if (salt && (salt.length < 32 || salt.length > 256 || /\s/.test(salt))) throw new Error('ჰეშის საიდუმლო უნდა იყოს 32–256 სიმბოლო, გამოტოვებების გარეშე.');
  }
  const origins = [...new Set(values.origins.split(/[\s,]+/).filter(Boolean))];
  if (!origins.length || origins.length > 20) throw new Error('მიუთითეთ 1–20 ნებადართული მისამართი.');
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('საიტის მისამართი არასწორია.'); }
    if (url.origin !== origin || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('მიუთითეთ HTTPS მისამართი ბილიკის გარეშე; HTTP დასაშვებია მხოლოდ ლოკალურად.');
  }
  return { p_bot_token: token || null, p_chat_id: chat || null, p_hash_salt: salt || null, p_enabled: values.enabled === true, p_origins: origins };
}

export function validatePublicConfig(url, key) {
  url = url.trim().replace(/\/$/, ''); key = key.trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('მიუთითეთ Supabase პროექტის HTTPS მისამართი.');
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publicKey && /^eyJ/.test(key)) {
    try {
      const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      publicKey = JSON.parse(atob(payload)).role === 'anon';
    } catch { publicKey = false; }
  }
  if (!publicKey) throw new Error('დასაშვებია მხოლოდ საჯარო publishable ან anon გასაღები. საიდუმლო და service-role გასაღები აქ არ შეიყვანოთ.');
  return { supabaseUrl: url, supabaseKey: key, contactEnabled: false };
}
