import { icon } from './icons';

export function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

export function toast(message: string, type: 'info' | 'error' = 'info'): void {
  const region = required('toast-region');
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = icon(type === 'error' ? 'close' : 'check');
  const text = document.createElement('span');
  text.textContent = message;
  element.append(text);
  region.append(element);
  window.setTimeout(() => {
    element.classList.add('leaving');
    window.setTimeout(() => element.remove(), 220);
  }, type === 'error' ? 4200 : 2800);
}

export function confirmAction(title: string, message: string, acceptLabel = '确认'): Promise<boolean> {
  const dialog = required<HTMLDialogElement>('confirm-dialog');
  required('confirm-title').textContent = title;
  required('confirm-message').textContent = message;
  required('confirm-accept').textContent = acceptLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (dialog.open) dialog.close();
    };
    required('confirm-accept').addEventListener('click', () => finish(true), { once: true });
    required('confirm-cancel').addEventListener('click', () => finish(false), { once: true });
    dialog.addEventListener('cancel', () => finish(false), { once: true });
    dialog.addEventListener('close', () => finish(false), { once: true });
  });
}

export function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel = '请稍候…'): void {
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
  }
}
