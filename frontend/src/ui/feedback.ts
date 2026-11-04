import { icon } from './icons';
import { gateToast } from './introGate';

export function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

/** 同一条 toast 可能被反复触发的计时器（淡出 / 移除），复用元素时要能取消。 */
const toastTimers = new WeakMap<HTMLElement, number[]>();

function scheduleToastDismiss(element: HTMLElement, type: 'info' | 'error'): void {
  const timers: number[] = [];
  timers.push(window.setTimeout(() => {
    element.classList.add('leaving');
    timers.push(window.setTimeout(() => element.remove(), 220));
  }, type === 'error' ? 4200 : 2800));
  toastTimers.set(element, timers);
}

/**
 * 顶部提示条。
 *
 * `key` 可选：传入后再触发同 key 的提示会**复用同一条**（更新文案、重置消失计时），
 * 而不是并列堆叠。铜铃这种会被连点器高频触发的提示必须带 key，否则一连串
 * toast 会向上堆成一堵墙把棋盘挡住。
 */
export function toast(message: string, type: 'info' | 'error' = 'info', key?: string): void {
  gateToast(() => renderToast(message, type, key), type === 'error', key);
}

function renderToast(message: string, type: 'info' | 'error', key?: string): void {
  const region = required('toast-region');
  const selector = key ? `[data-toast-key="${key}"]` : null;
  let element = selector ? region.querySelector<HTMLElement>(selector) : null;

  if (element) {
    // 复用已有那条：取消旧计时、清掉淡出状态与旧内容，保持它一直可见。
    for (const timer of toastTimers.get(element) ?? []) window.clearTimeout(timer);
    element.classList.remove('leaving');
    element.className = `toast ${type}`;
    element.replaceChildren();
  } else {
    element = document.createElement('div');
    element.className = `toast ${type}`;
    if (key) element.dataset.toastKey = key;
    region.append(element);
  }

  element.innerHTML = icon(type === 'error' ? 'close' : 'check');
  const text = document.createElement('span');
  text.textContent = message;
  element.append(text);
  scheduleToastDismiss(element, type);
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
