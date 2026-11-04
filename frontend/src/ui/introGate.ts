/**
 * 开局推镜期间的界面让位。
 *
 * 推镜只有 5.4 秒，却是整局里唯一能看到房间全貌的时刻。以前这 5 秒里
 * 叙事行、对局条、底部按钮、toast 全都在，把「先看身处何处」的镜头挡得
 * 七零八落；「已以游客身份进入」「棋局已创建」这类开场提示也正好压在
 * 画面中央。这里做两件事：
 *
 * 1. 推镜期间给 <html> 挂 `intro-running`，CSS 据此淡出对局 HUD；
 * 2. 非关键 toast 不立刻弹，排队到推镜结束再放（error 永远立即显示）。
 *
 * 兜底很重要：推镜可能因切场景、减少动态效果、组件销毁而中断，
 * 所以 beginIntro 带一个看门狗，超时自己收场，绝不把 HUD 永久藏起来。
 */

let running = false;
let watchdog: number | null = null;
const pending: Array<{ show: () => void; key: string | undefined }> = [];

/** 推镜结束后最多补放两条开场提示，且错开一点，避免又堆成一堵墙。 */
const MAX_DEFERRED = 2;
const DEFER_GAP_MS = 380;

function clearWatchdog(): void {
  if (watchdog !== null) {
    window.clearTimeout(watchdog);
    watchdog = null;
  }
}

export function beginIntro(durationMs = 5400): void {
  running = true;
  document.documentElement.classList.add('intro-running');
  clearWatchdog();
  watchdog = window.setTimeout(endIntro, durationMs + 2500);
}

export function endIntro(): void {
  if (!running) return;
  running = false;
  clearWatchdog();
  document.documentElement.classList.remove('intro-running');

  const queued = pending.splice(0).slice(-MAX_DEFERRED);
  queued.forEach(({ show }, index) => {
    if (index === 0) show();
    else window.setTimeout(show, index * DEFER_GAP_MS);
  });
}

/**
 * 把一次 toast 交给门禁。
 *
 * @param urgent 错误提示不排队，立刻显示。
 * @param key    同一条提示（如铜铃连点）只保留最后一次。
 */
export function gateToast(show: () => void, urgent: boolean, key?: string): void {
  if (urgent || !running) {
    show();
    return;
  }
  const existing = key ? pending.findIndex((item) => item.key === key) : -1;
  if (existing >= 0) pending.splice(existing, 1);
  pending.push({ show, key });
  if (pending.length > MAX_DEFERRED + 2) pending.shift();
}
