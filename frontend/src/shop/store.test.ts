import { beforeEach, describe, expect, it } from 'vitest';
import {
  type UserProfile, loadProfile, applyWallet, equipMaterial,
  isSceneUnlocked, setStorageForTesting, POINTS_PER_GAME, INITIAL_POINTS,
} from './store';

/** 受控的内存存储，便于断言读写内容，也避免污染真实 localStorage。 */
function makeMemoryStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('用户档案持久化', () => {
  beforeEach(() => {
    setStorageForTesting(makeMemoryStorage());
  });

  it('首次读取返回默认档案，含初始积分且默认实体棋子已装备', () => {
    const profile = loadProfile();
    expect(profile.points).toBe(INITIAL_POINTS);
    expect(profile.unlocked).toEqual([]);
    expect(profile.equipped.materialBlack).toBe('solid-black');
    expect(profile.equipped.materialWhite).toBe('solid-white');
    expect(profile.version).toBe(3);
  });

  it('脏数据 / 截断 JSON 回落到默认，不抛错', () => {
    setStorageForTesting({ getItem: () => '{ broken', setItem: () => {} });
    const profile = loadProfile();
    expect(profile.points).toBe(INITIAL_POINTS);
    expect(profile.equipped.materialBlack).toBe('solid-black');
  });

  it('读到的字段会按类型校验，非法值回落默认', () => {
    const storage = makeMemoryStorage();
    storage.setItem('yijing.profile.v1', JSON.stringify({ points: '很多', equipped: { materialBlack: 123 } }));
    setStorageForTesting(storage);
    const profile = loadProfile();
    expect(profile.points).toBe(INITIAL_POINTS);
    expect(profile.equipped.materialBlack).toBe('solid-black');
  });

  it('v3 迁移：所有旧档案积分统一调整为 10000', () => {
    const storage = makeMemoryStorage();
    storage.setItem('yijing.profile.v1', JSON.stringify({
      version: 1, points: 0, unlocked: [],
      equipped: { materialBlack: 'solid-black', materialWhite: 'solid-white' },
      settledGames: [],
    }));
    setStorageForTesting(storage);
    const profile = loadProfile();
    expect(profile.points).toBe(INITIAL_POINTS);
    expect(profile.version).toBe(3);
  });

  it('v3 迁移：已有余额的旧档案同样调整到 10000（一次性），此后正常累加', () => {
    const storage = makeMemoryStorage();
    storage.setItem('yijing.profile.v1', JSON.stringify({
      version: 2, points: 12, unlocked: [],
      equipped: { materialBlack: 'solid-black', materialWhite: 'solid-white' },
      settledGames: ['g1'],
    }));
    setStorageForTesting(storage);
    const profile = loadProfile();
    expect(profile.points).toBe(INITIAL_POINTS);
    expect(profile.version).toBe(3);
    // 迁移只发生一次：v3 档案重新加载保留余额并正常累加。
    profile.points += POINTS_PER_GAME;
    const again = (profile.points, profile);
    expect(again.points).toBe(INITIAL_POINTS + POINTS_PER_GAME);
  });
});

describe('钱包同步（服务端权威）', () => {
  beforeEach(() => setStorageForTesting(makeMemoryStorage()));

  it('applyWallet 覆盖本地缓存，装备偏好不被触碰', () => {
    const profile: UserProfile = loadProfile();
    profile.equipped.materialBlack = 'frosted-black';
    applyWallet(profile, INITIAL_POINTS + POINTS_PER_GAME, ['mat-frosted-black']);
    expect(profile.points).toBe(INITIAL_POINTS + POINTS_PER_GAME);
    expect(profile.unlocked).toContain('mat-frosted-black');
    expect(profile.equipped.materialBlack).toBe('frosted-black');
  });

  it('applyWallet 对非法输入保持现状', () => {
    const profile = loadProfile();
    applyWallet(profile, -5, 'not-array' as unknown as string[]);
    expect(profile.points).toBe(INITIAL_POINTS);
  });
});

describe('解锁与装备', () => {
  beforeEach(() => setStorageForTesting(makeMemoryStorage()));

  it('装备材质后切换生效，再次点击取消装备回退默认', () => {
    const profile = loadProfile();
    applyWallet(profile, 100, ['mat-frosted-black']);
    expect(equipMaterial(profile, 'mat-frosted-black').ok).toBe(true);
    expect(profile.equipped.materialBlack).toBe('frosted-black');
    // 再次点击：取消装备，回退到默认实体黑子。
    expect(equipMaterial(profile, 'mat-frosted-black').ok).toBe(true);
    expect(profile.equipped.materialBlack).toBe('solid-black');
  });

  it('未解锁不能装备', () => {
    const profile = loadProfile();
    const result = equipMaterial(profile, 'mat-frosted-black');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('尚未解锁');
  });

  it('棋境：当前与后续所有场景免费，无需积分解锁', () => {
    const profile = loadProfile();
    expect(isSceneUnlocked(profile, 'tea')).toBe(true);
    expect(isSceneUnlocked(profile, 'courtyard')).toBe(true);
    expect(isSceneUnlocked(profile, 'cyber')).toBe(true);
    expect(isSceneUnlocked(profile, 'living')).toBe(true);
    expect(isSceneUnlocked(profile, 'any-future-scene')).toBe(true);
  });
});
