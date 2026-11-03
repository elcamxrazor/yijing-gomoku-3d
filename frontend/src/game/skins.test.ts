import { describe, expect, it } from 'vitest';
import type { GameSnapshot } from './types';
import { resolveStoneSkins } from './skins';

const equipped = { materialBlack: 'solid-black', materialWhite: 'solid-white' };

function online(yourColor: 1 | 2, blackSkin?: string, whiteSkin?: string): GameSnapshot {
  return {
    mode: 'online',
    yourColor,
    players: {
      black: { id: 'b', name: 'B', ...(blackSkin ? { skin: blackSkin } : {}) },
      white: { id: 'w', name: 'W', ...(whiteSkin ? { skin: whiteSkin } : {}) },
    },
  } as unknown as GameSnapshot;
}

describe('resolveStoneSkins', () => {
  it('本地 / 人机：双方都跟随自己装备的皮肤', () => {
    expect(resolveStoneSkins(null, equipped, true)).toEqual(['solid-black', 'solid-white']);
    const local = { mode: 'local', yourColor: 1, players: { black: { id: 'a', name: 'A' }, white: null } } as unknown as GameSnapshot;
    expect(resolveStoneSkins(local, equipped, false)).toEqual(['solid-black', 'solid-white']);
  });

  it('联机自己执黑、开启对方皮肤：白子用对方皮肤', () => {
    expect(resolveStoneSkins(online(1, 'frosted-cyan', 'translucent-white'), equipped, true))
      .toEqual(['solid-black', 'translucent-white']);
  });

  it('联机自己执白、开启对方皮肤：黑白不得对调（回归）', () => {
    // 自己执白：黑子必须用对方的黑皮肤，白子用自己的白皮肤。
    expect(resolveStoneSkins(online(2, 'frosted-cyan', 'translucent-white'), equipped, true))
      .toEqual(['frosted-cyan', 'solid-white']);
  });

  it('联机关闭对方皮肤：双方都用自己同色皮肤', () => {
    const mine = { materialBlack: 'frosted-cyan', materialWhite: 'translucent-white' };
    expect(resolveStoneSkins(online(2, 'solid-black', 'solid-white'), mine, false))
      .toEqual(['frosted-cyan', 'translucent-white']);
  });

  it('对方未装备皮肤时回退到该色的默认实体棋子', () => {
    expect(resolveStoneSkins(online(1), equipped, true)).toEqual(['solid-black', 'solid-white']);
    expect(resolveStoneSkins(online(2), equipped, true)).toEqual(['solid-black', 'solid-white']);
  });
});
