export function confirmAction(text) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog'); dialog.className = 'confirm-dialog';
    const heading = document.createElement('h2'); heading.textContent = 'დადასტურება';
    const message = document.createElement('p'); message.textContent = text;
    const actions = document.createElement('div');
    for (const [label, value] of [['გაუქმება', false], ['გაგრძელება', true]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = label;
      if (!value) button.autofocus = true;
      button.addEventListener('click', () => { dialog.close(); dialog.remove(); resolve(value); }); actions.append(button);
    }
    dialog.addEventListener('cancel', () => { dialog.remove(); resolve(false); });
    dialog.append(heading, message, actions); document.body.append(dialog); dialog.showModal();
  });
}
