import { describe, expect, it } from 'vitest';
import { offlineOpponent } from './presence';

describe('断线横幅该看谁', () => {
  it('黑方只关心白方掉线', () => {
    expect(offlineOpponent({ black: 0, white: 90_000 }, 1)).toEqual({ color: 2, remainingMs: 90_000 });
    // 自己掉线不会产生这条界面，所以不该返回自己的颜色。
    expect(offlineOpponent({ black: 90_000, white: 0 }, 1)).toBeNull();
  });

  it('白方只关心黑方掉线', () => {
    expect(offlineOpponent({ black: 12_000, white: 0 }, 2)).toEqual({ color: 1, remainingMs: 12_000 });
    expect(offlineOpponent({ black: 0, white: 12_000 }, 2)).toBeNull();
  });

  it('观战者两边都看得到，先报白方', () => {
    expect(offlineOpponent({ black: 5_000, white: 0 }, null)).toEqual({ color: 1, remainingMs: 5_000 });
    expect(offlineOpponent({ black: 5_000, white: 8_000 }, null)).toEqual({ color: 2, remainingMs: 8_000 });
  });

  it('都在线时不显示横幅', () => {
    expect(offlineOpponent({ black: 0, white: 0 }, null)).toBeNull();
    expect(offlineOpponent({ black: 0, white: 0 }, 1)).toBeNull();
  });
});
