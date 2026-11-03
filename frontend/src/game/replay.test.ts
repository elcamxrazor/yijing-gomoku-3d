import { describe, expect, it } from 'vitest';
import {
  boardAt,
  clampIndex,
  emptyBoard,
  formatDateTime,
  formatDateTimeShort,
  formatDuration,
  lastMoveAt,
  resultLabel,
  type ReplayMove,
} from './replay';

function moves(sequence: Array<[number, number, 1 | 2]>): ReplayMove[] {
  return sequence.map(([row, col, color], index) => ({ index, row, col, color }));
}

describe('复盘：按手数重建棋盘', () => {
  const sample = moves([
    [7, 7, 1],
    [7, 8, 2],
    [8, 8, 1],
  ]);

  it('0 手是空盘', () => {
    const board = boardAt(sample, 0);
    expect(board).toEqual(emptyBoard());
    expect(lastMoveAt(sample, 0)).toBeNull();
  });

  it('摆到第 n 手只包含前 n 手', () => {
    const board = boardAt(sample, 2);
    expect(board[7]?.[7]).toBe(1);
    expect(board[7]?.[8]).toBe(2);
    expect(board[8]?.[8]).toBe(0);
    expect(lastMoveAt(sample, 2)).toEqual({ row: 7, col: 8, color: 2 });
  });

  it('手数超过总手数时按总手数算', () => {
    const board = boardAt(sample, 99);
    expect(board[8]?.[8]).toBe(1);
    expect(lastMoveAt(sample, 99)).toEqual({ row: 8, col: 8, color: 1 });
  });

  it('负手数按 0 算', () => {
    expect(boardAt(sample, -5)).toEqual(emptyBoard());
    expect(lastMoveAt(sample, -5)).toBeNull();
  });

  it('每次返回新的棋盘，互不影响', () => {
    const first = boardAt(sample, 1);
    const second = boardAt(sample, 3);
    expect(first[8]?.[8]).toBe(0);
    expect(second[8]?.[8]).toBe(1);
  });

  it('越界的着法被忽略而不是抛错', () => {
    const board = boardAt(moves([[99, 99, 1]]), 1);
    expect(board).toEqual(emptyBoard());
  });
});

describe('复盘：进度与文案', () => {
  it('clampIndex 夹在有效区间内', () => {
    expect(clampIndex(-3, 10)).toBe(0);
    expect(clampIndex(4.6, 10)).toBe(5);
    expect(clampIndex(30, 10)).toBe(10);
    expect(clampIndex(Number.NaN, 10)).toBe(0);
  });

  it('结果文案区分认输 / 掉线 / 五连 / 和棋', () => {
    expect(resultLabel({ winner: 1, winReason: 'five' })).toContain('黑胜');
    expect(resultLabel({ winner: 2, winReason: 'resign' })).toBe('白胜 · 对方认输');
    expect(resultLabel({ winner: 1, winReason: 'offline' })).toBe('黑胜 · 对方掉线');
    expect(resultLabel({ winner: 0, winReason: 'draw' })).toBe('和棋');
    expect(resultLabel({ winner: 0, winReason: null })).toBe('未分胜负');
  });

  it('日期时间按本地时区格式化，且补零', () => {
    // 用本地时间构造再转 ISO：无论测试机在哪个时区，读回来都该是同一串。
    const local = new Date(2026, 10, 1, 22, 5, 30);
    expect(formatDateTime(local.toISOString())).toBe('2026-11-01 22:05');
    expect(formatDateTimeShort(local.toISOString())).toBe('11-01 22:05');

    const early = new Date(2026, 0, 9, 7, 8, 0);
    expect(formatDateTime(early.toISOString())).toBe('2026-01-09 07:08');
  });

  it('日期时间对空值与脏数据返回空串', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime('not-a-date')).toBe('');
    expect(formatDateTimeShort(undefined as unknown as null)).toBe('');
  });

  it('用时格式化', () => {
    const start = '2026-11-01T10:00:00+00:00';
    expect(formatDuration(start, '2026-11-01T10:00:58+00:00')).toBe('58 秒');
    expect(formatDuration(start, '2026-11-01T10:05:00+00:00')).toBe('5 分');
    expect(formatDuration(start, '2026-11-01T10:12:30+00:00')).toBe('12 分 30 秒');
    expect(formatDuration(null, null)).toBe('');
    expect(formatDuration(start, start)).toBe('');
  });
});
