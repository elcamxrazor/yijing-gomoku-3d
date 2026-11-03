import { describe, expect, it } from 'vitest';
import { locate, perceivedGain } from './station';

const tracks = [
  { id: 'a', durationMs: 10_000 },
  { id: 'b', durationMs: 10_000 },
  { id: 'c', durationMs: 10_000 },
];

/** anchor 记录在 t=1000，第 0 首第 0 秒。 */
const anchor = { index: 0, positionMs: 0, sampledAt: 1_000 };

describe('locate', () => {
  it('锚点当时就是锚点本身', () => {
    expect(locate(tracks, anchor, 1_000)).toEqual({ index: 0, positionMs: 0 });
  });

  it('随本机时间向前推进', () => {
    expect(locate(tracks, anchor, 6_000)).toEqual({ index: 0, positionMs: 5_000 });
  });

  it('跨过第一首之后落在第二首中间', () => {
    expect(locate(tracks, anchor, 16_000)).toEqual({ index: 1, positionMs: 5_000 });
  });

  it('走到最后一首的尾部', () => {
    expect(locate(tracks, { index: 2, positionMs: 8_000, sampledAt: 0 }, 1_500)).toEqual({
      index: 2,
      positionMs: 9_500,
    });
  });

  it('一轮放完绕回开头', () => {
    expect(locate(tracks, anchor, 31_000)).toEqual({ index: 0, positionMs: 0 });
    expect(locate(tracks, anchor, 36_000)).toEqual({ index: 0, positionMs: 5_000 });
  });

  it('时间倒流（时钟被调过）时夹到 0 而不是负数', () => {
    expect(locate(tracks, { index: 1, positionMs: 3_000, sampledAt: 5_000 }, 4_000)).toEqual({
      index: 1,
      positionMs: 3_000,
    });
  });

  it('锚点索引越界也能收回一圈之内', () => {
    expect(locate(tracks, { index: 7, positionMs: 0, sampledAt: 0 }, 0)).toEqual({
      index: 1,
      positionMs: 0,
    });
  });

  it('没有曲目时返回 null', () => {
    expect(locate([], anchor, 1_000)).toBeNull();
  });

  it('单曲循环不会停', () => {
    const single = [{ id: 'only', durationMs: 5_000 }];
    expect(locate(single, anchor, 1_000)).toEqual({ index: 0, positionMs: 0 });
    expect(locate(single, anchor, 7_500)).toEqual({ index: 0, positionMs: 1_500 });
  });
});

describe('perceivedGain', () => {
  it('是平方曲线：50% 只有四分之一振幅', () => {
    expect(perceivedGain(0)).toBe(0);
    expect(perceivedGain(0.5)).toBeCloseTo(0.25, 6);
    expect(perceivedGain(0.25)).toBeCloseTo(0.0625, 6);
    expect(perceivedGain(1)).toBe(1);
  });

  it('越界值被夹住', () => {
    expect(perceivedGain(-1)).toBe(0);
    expect(perceivedGain(2)).toBe(1);
  });
});
