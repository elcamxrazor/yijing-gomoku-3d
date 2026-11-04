import type { GameClock, TimeControl } from './types';

/** 每步限时可选的毫秒档位；与后端 `ALLOWED_PER_MOVE_MS` 一一对应。 */
export const PER_MOVE_OPTIONS = [30_000, 60_000, 120_000] as const;

/** 最后这么多毫秒进入「警示」态：数字换色 + 轻微脉动。 */
export const LOW_TIME_MS = 10_000;

export const NO_TIME_CONTROL: TimeControl = { mode: 'none', perMoveMs: null };

/**
 * 剩余时间（毫秒）。
 *
 * 只认 `deadlineAt` 与「现在」两个量：**每次都重算**，不做累减。
 * 移动端切到后台时 `setInterval` 会被浏览器节流到每秒甚至停摆，
 * 自减会一路走偏，回到前台显示的时间就错了；用截止时刻重算则瞬间自愈。
 */
export function remainingMs(deadlineAt: number | null, now: number): number {
  if (deadlineAt === null || !Number.isFinite(deadlineAt)) return 0;
  return Math.max(0, deadlineAt - now);
}

/** 毫秒 → `mm:ss`。向上取整：剩 0.4 秒也显示 00:01，归零才显示 00:00。 */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 本机钟与服务端钟的偏差（毫秒）：`本机现在 - 服务端现在`。
 *
 * 服务端只发「截止时刻」和「下发那一刻的剩余」，两者相减正好是服务端眼中的
 * 「此刻」。玩家电脑的钟快慢几分钟并不罕见，直接拿 `deadlineAt` 减本机时间，
 * 屏幕上的秒数会整体偏掉（可能是五分钟）；扣掉这个偏差，两条时间轴才对得齐。
 *
 * 网络延迟会让剩余时间略微高估（约等于单程延迟），这是可接受的方向——
 * 宁可让玩家多看到半秒，也不要提前把数字压到 0。
 *
 * @returns 无 `remainingMs` 时返回 0（退化为直接使用 `deadlineAt`）。
 */
export function clockOffset(
  deadlineAt: number,
  remainingMs: number | null,
  now: number,
): number {
  if (!Number.isFinite(deadlineAt) || remainingMs === null || !Number.isFinite(remainingMs)) {
    return 0;
  }
  return now - (deadlineAt - remainingMs);
}

/** 是否该亮警示色。 */
export function isLowTime(ms: number): boolean {
  return ms > 0 && ms <= LOW_TIME_MS;
}

/** 档位的短文案：`不限时` / `30 秒`。 */
export function timeControlLabel(control: TimeControl | null | undefined): string {
  if (!control || control.mode !== 'perMove' || !control.perMoveMs) return '不限时';
  return `${Math.round(control.perMoveMs / 1000)} 秒`;
}

/**
 * 该不该在这盘棋上显示倒计时。
 *
 * 只有「正在进行、有表」的联机对局才显示。终局后服务端会把 clock 收成 null，
 * 但快照到达前的那一帧本地还拿着旧值，所以这里再兜一次。
 */
export function clockVisible(
  status: string,
  clock: GameClock | null | undefined,
): clock is GameClock & { deadlineAt: number } {
  return status === 'playing' && !!clock && typeof clock.deadlineAt === 'number';
}
