import type { GamePresence, PlayerColor } from './types';

export interface OfflinePlayer {
  color: PlayerColor;
  /** 距离判负还剩多少毫秒。 */
  remainingMs: number;
}

/**
 * 从快照的 `presence` 里挑出「该给这个人看的那位」。
 *
 * 规则只有一条：**只看对面**。自己掉线时这条界面根本收不到消息，把「我」也
 * 算进来只会让横幅写着「我已断线」这种没人能看见的话。观战者没有颜色，
 * 两位都算对面，先报白方——他只是看棋的，不需要同时处理两条倒计时。
 */
export function offlineOpponent(
  presence: GamePresence,
  mine: PlayerColor | null,
): OfflinePlayer | null {
  if (mine !== 2 && presence.white > 0) return { color: 2, remainingMs: presence.white };
  if (mine !== 1 && presence.black > 0) return { color: 1, remainingMs: presence.black };
  return null;
}
