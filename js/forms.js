// Browser-owned date placeholders and validation messages follow the browser locale.
export function contactDate(value) {
  if (!value) return '';
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) throw new Error('შეიყვანეთ თარიღი ფორმატით დღე.თვე.წელი, მაგალითად 25.12.2026.');
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(iso);
  if (match[3] === '0000' || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    throw new Error('შეიყვანეთ არსებული კალენდარული თარიღი.');
  }
  return iso;
}

export function validateField(field) {
  if (field.dataset.cmsError) { field.setCustomValidity(field.dataset.cmsError); return; }
  field.setCustomValidity('');
  const validity = field.validity;
  let error = '';
  if (validity.valueMissing) error = 'გთხოვთ, შეავსოთ ეს ველი.';
  else if (validity.typeMismatch) error = field.type === 'url' ? 'შეიყვანეთ სრული HTTPS ბმული.' : 'შეიყვანეთ სწორი ელფოსტის მისამართი.';
  else if (validity.tooShort) error = `შეიყვანეთ სულ მცირე ${field.minLength} სიმბოლო.`;
  else if (validity.tooLong) error = `შეიყვანეთ არაუმეტეს ${field.maxLength} სიმბოლოსი.`;
  else if (validity.rangeUnderflow || validity.rangeOverflow) error = `შეიყვანეთ რიცხვი ${field.min}-დან ${field.max}-მდე.`;
  else if (validity.stepMismatch || validity.badInput) error = 'შეიყვანეთ მთელი რიცხვი.';
  else if (validity.patternMismatch) error = 'შეამოწმეთ ველის ფორმატი.';
  if (field.hasAttribute('data-contact-date')) {
    try { contactDate(field.value); } catch (failure) { error = failure.message; }
  }
  field.setCustomValidity(error);
}

export function localizeForms() {
  for (const name of ['input', 'change', 'invalid']) {
    document.addEventListener(name, (event) => {
      if (typeof event.target.setCustomValidity === 'function') {
        if (name !== 'invalid') delete event.target.dataset.cmsError;
        validateField(event.target);
        if (name === 'invalid') event.target.closest('details')?.setAttribute('open', '');
      }
    }, true);
  }
  document.addEventListener('submit', (event) => {
    if (event.target.noValidate) return;
    for (const field of event.target.elements) {
      if (field.willValidate) validateField(field);
    }
    if (!event.target.reportValidity()) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
