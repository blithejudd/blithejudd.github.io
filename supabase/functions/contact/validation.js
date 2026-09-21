export function validateContact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request');
  if (input.website) throw new Error('Invalid request');
  const read = (key, min, max) => {
    if (typeof input[key] !== 'string') throw new Error('Invalid field');
    const value = input[key].trim();
    if (value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Invalid field');
    return value;
  };
  const name = read('name', 1, 100);
  const contact = read('contact', 3, 160);
  const category = read('category', 1, 64);
  const date = read('date', 0, 10);
  const message = read('message', 0, 2000);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(category) || category === 'all') throw new Error('Invalid category');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Invalid date');
  return { name, contact, category, date, message };
}

export function telegramMessage(values) {
  // Plain text, deliberately no parse_mode: visitor input cannot inject markup.
  const labels = { portraits: 'პორტრეტი', editorial: 'ედიტორიალი', family: 'ოჯახი', weddings: 'ქორწილი' };
  return ['ახალი მოთხოვნა gulievi.me-დან', `სახელი: ${values.name}`, `კონტაქტი: ${values.contact}`, `გადაღება: ${values.category_name || labels[values.category] || values.category}`, `თარიღი: ${values.date || 'არ არის მითითებული'}`, `შეტყობინება: ${values.message || '—'}`].join('\n');
}
