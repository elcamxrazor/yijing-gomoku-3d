import { describe, expect, it } from 'vitest';
import type { ReplayRecord } from './replay';
import { canContinueFrom, continuePly, firstMoverNote, presetFrom, sideToMove } from './continue';

function makeRecord(overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    id: 'g1',
    mode: 'ai',
    scene: 'tea',
    rule: 'freestyle',
    status: 'finished',
    winner: 1,
    winReason: 'five',
    moveCount: 3,
    startPly: 0,
    players: { black: { id: '1', name: '黑' }, white: { id: '2', name: '白' } },
    yourColor: 1,
    createdAt: null,
    finishedAt: null,
    moves: [
      { index: 0, row: 7, col: 7, color: 1 },
      { index: 1, row: 7, col: 8, color: 2 },
      { index: 2, row: 8, col: 8, color: 1 },
    ],
    ...overrides,
  };
}

describe('残局前缀', () => {
  it('取第 n 手之后的盘面，只留坐标（颜色由服务端按手数推）', () => {
    const preset = presetFrom(makeRecord(), 2);
    expect(preset).toEqual([
      { row: 7, col: 7 },
      { row: 7, col: 8 },
    ]);
    // 不能把 color 带过去：两份颜色口径迟早会打架，而棋盘不会说话。
    expect(preset[0]).not.toHaveProperty('color');
  });

  it('第 0 手是空前缀，正好等于「正常开局」', () => {
    expect(presetFrom(makeRecord(), 0)).toEqual([]);
  });

  it('越界的下标夹紧到棋谱范围内', () => {
    expect(presetFrom(makeRecord(), 99)).toHaveLength(3);
    expect(presetFrom(makeRecord(), -5)).toEqual([]);
  });

  it('continuePly 与 presetFrom 用的是同一个夹紧口径', () => {
    expect(continuePly(makeRecord(), 99)).toBe(3);
    expect(continuePly(makeRecord(), -1)).toBe(0);
  });
});

describe('能不能从这一手接手', () => {
  it('空盘不行：那和「开一局新人机」没有区别', () => {
    expect(canContinueFrom(makeRecord(), 0)).toBe(false);
  });

  it('中盘任意一手都可以', () => {
    expect(canContinueFrom(makeRecord(), 1)).toBe(true);
    expect(canContinueFrom(makeRecord(), 2)).toBe(true);
  });

  it('走到末尾的五连：已经下无可下', () => {
    expect(canContinueFrom(makeRecord({ winReason: 'five' }), 3)).toBe(false);
  });

  it('走到末尾的满盘和棋：同样下无可下', () => {
    expect(canContinueFrom(makeRecord({ winReason: 'draw' }), 3)).toBe(false);
  });

  it('认输 / 掉线 / 超时的终局盘面还能接着下', () => {
    for (const winReason of ['resign', 'offline', 'timeout'] as const) {
      expect(canContinueFrom(makeRecord({ winReason }), 3)).toBe(true);
    }
  });

  it('下标超出棋谱长度时不行', () => {
    expect(canContinueFrom(makeRecord(), 4)).toBe(false);
  });
});

describe('接手之后谁先走', () => {
  it('偶数手轮到黑，奇数手轮到白', () => {
    expect(sideToMove(0)).toBe(1);
    expect(sideToMove(1)).toBe(2);
    expect(sideToMove(4)).toBe(1);
  });

  it('按钮小字要说清是不是引擎先走', () => {
    // 4 手残局轮到黑：选「计算机执黑」就是引擎先动。
    expect(firstMoverNote(4, 'black')).toBe('轮到计算机先行');
    expect(firstMoverNote(4, 'white')).toBe('轮到你先行');
    // 5 手残局轮到白，反过来。
    expect(firstMoverNote(5, 'white')).toBe('轮到计算机先行');
    expect(firstMoverNote(5, 'black')).toBe('轮到你先行');
  });
});
