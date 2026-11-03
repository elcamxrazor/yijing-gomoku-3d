import { describe, expect, it } from 'vitest';
import {
  MOVE_NUMBER_OPTIONS,
  loadSettings,
  normalizeMoveNumberMode,
  saveSettings,
  visibleMoveIndices,
} from './settings';

/** 最小可用的 Storage 替身：只实现用到的那几个方法。 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('设置：手数编号的取值', () => {
  it('四档都是合法值', () => {
    for (const option of MOVE_NUMBER_OPTIONS) {
      expect(normalizeMoveNumberMode(option.value)).toBe(option.value);
    }
  });

  it('乱七八糟的值退回「不显示」', () => {
    expect(normalizeMoveNumberMode(undefined)).toBe('off');
    expect(normalizeMoveNumberMode(null)).toBe('off');
    expect(normalizeMoveNumberMode('LAST')).toBe('off');
    expect(normalizeMoveNumberMode(3)).toBe('off');
  });
});

describe('设置：持久化', () => {
  it('存进去再读出来是同一份', () => {
    const storage = fakeStorage();
    saveSettings({ moveNumbers: 'all', showOpponentSkin: true, showBoardCoordinates: false }, storage);
    expect(loadSettings(storage).moveNumbers).toBe('all');
  });

  it('没有存档时用默认值', () => {
    expect(loadSettings(fakeStorage()).moveNumbers).toBe('off');
  });

  it('存档损坏时不抛错，退回默认', () => {
    expect(loadSettings(fakeStorage({ 'yijing.settings.v1': '{ not json' })).moveNumbers).toBe('off');
    expect(loadSettings(fakeStorage({ 'yijing.settings.v1': '[]' })).moveNumbers).toBe('off');
  });

  it('存档里的字段非法时只退回那一项', () => {
    const storage = fakeStorage({ 'yijing.settings.v1': JSON.stringify({ moveNumbers: 'weird' }) });
    expect(loadSettings(storage).moveNumbers).toBe('off');
  });

  it('没有 storage 时读写都不炸', () => {
    expect(loadSettings(null).moveNumbers).toBe('off');
    expect(() => saveSettings({ moveNumbers: 'last', showOpponentSkin: true, showBoardCoordinates: false }, null)).not.toThrow();
  });
});

describe('设置：该给哪几手标号', () => {
  it('不显示时是空的', () => {
    expect(visibleMoveIndices('off', 10)).toEqual([]);
  });

  it('全部步数覆盖每一手', () => {
    expect(visibleMoveIndices('all', 4)).toEqual([0, 1, 2, 3]);
  });

  it('最新一步只标最后一手', () => {
    expect(visibleMoveIndices('last', 10)).toEqual([9]);
  });

  it('最新两步标最后两手，顺序保持从早到晚', () => {
    expect(visibleMoveIndices('lastTwo', 10)).toEqual([8, 9]);
  });

  it('手数不足时不会给出负数序号', () => {
    expect(visibleMoveIndices('lastTwo', 1)).toEqual([0]);
    expect(visibleMoveIndices('last', 0)).toEqual([]);
    expect(visibleMoveIndices('lastTwo', 0)).toEqual([]);
  });

  it('总数异常时按空处理', () => {
    expect(visibleMoveIndices('all', -3)).toEqual([]);
    expect(visibleMoveIndices('last', Number.NaN)).toEqual([]);
  });
});
