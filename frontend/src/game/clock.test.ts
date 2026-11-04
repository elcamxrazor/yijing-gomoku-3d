import { describe, expect, it } from 'vitest';
import {
  LOW_TIME_MS,
  NO_TIME_CONTROL,
  PER_MOVE_OPTIONS,
  clockLabel,
  clockOffset,
  clockVisible,
  isLowTime,
  remainingMs,
  timeControlLabel,
} from './clock';

describe('剩余时间重算', () => {
  it('按截止时刻与当前时刻算，不做累减', () => {
    const deadline = 1_000_000;
    expect(remainingMs(deadline, 970_000)).toBe(30_000);
    // 切后台 30 秒回来：一次重算就自愈，不会停在「还剩 29 秒」。
    expect(remainingMs(deadline, 1_000_000)).toBe(0);
    expect(remainingMs(deadline, 1_030_000)).toBe(0);
  });

  it('没有表时返回 0，不抛错', () => {
    expect(remainingMs(null, 123)).toBe(0);
    expect(remainingMs(Number.NaN, 123)).toBe(0);
  });
});

describe('倒计时文案', () => {
  it('格式化成 mm:ss', () => {
    expect(clockLabel(30_000)).toBe('00:30');
    expect(clockLabel(120_000)).toBe('02:00');
    expect(clockLabel(9_000)).toBe('00:09');
  });

  it('向上取整：还剩半秒也显示 1 秒，归零才显示 00:00', () => {
    expect(clockLabel(400)).toBe('00:01');
    expect(clockLabel(1)).toBe('00:01');
    expect(clockLabel(0)).toBe('00:00');
    expect(clockLabel(-5_000)).toBe('00:00');
  });
});

describe('警示阈值', () => {
  it('只在最后 10 秒亮警示色', () => {
    expect(isLowTime(LOW_TIME_MS + 1)).toBe(false);
    expect(isLowTime(LOW_TIME_MS)).toBe(true);
    expect(isLowTime(1_000)).toBe(true);
  });

  it('已经归零不再闪：那是「结算中」，不是「快超时」', () => {
    expect(isLowTime(0)).toBe(false);
  });
});

describe('档位文案', () => {
  it('不限时与具体秒数', () => {
    expect(timeControlLabel(NO_TIME_CONTROL)).toBe('不限时');
    expect(timeControlLabel(undefined)).toBe('不限时');
    expect(timeControlLabel({ mode: 'perMove', perMoveMs: 60_000 })).toBe('60 秒');
  });

  it('档位与后端白名单一致', () => {
    expect([...PER_MOVE_OPTIONS]).toEqual([30_000, 60_000, 120_000]);
  });
});

describe('校时', () => {
  it('本机钟准：偏差为零，算出来的剩余与下发值一致', () => {
    // 服务端此刻 1_000_000，剩 30 秒 → 截止 1_030_000；本机钟一样准。
    const offset = clockOffset(1_030_000, 30_000, 1_000_000);
    expect(offset).toBe(0);
    expect(remainingMs(1_030_000, 1_000_000 - offset)).toBe(30_000);
  });

  it('本机钟快 5 分钟：扣掉偏差后仍显示完整的 30 秒', () => {
    const now = 1_000_000 + 300_000; // 本机比服务端快 5 分钟
    const offset = clockOffset(1_030_000, 30_000, now);
    expect(offset).toBe(300_000);
    expect(remainingMs(1_030_000, now - offset)).toBe(30_000);
  });

  it('本机钟慢 2 分钟也不会把剩余算成溢出的大数', () => {
    const now = 1_000_000 - 120_000;
    const offset = clockOffset(1_030_000, 30_000, now);
    expect(offset).toBe(-120_000);
    expect(remainingMs(1_030_000, now - offset)).toBe(30_000);
  });

  it('没有 remainingMs 时退化为不校时，而不是算出一个荒谬的偏差', () => {
    expect(clockOffset(1_030_000, null, 1_000_000)).toBe(0);
    expect(clockOffset(Number.NaN, 30_000, 1_000_000)).toBe(0);
  });
});

describe('该不该显示倒计时', () => {
  it('进行中且有表才显示', () => {
    expect(clockVisible('playing', { side: 1, deadlineAt: 1, remainingMs: 1 })).toBe(true);
  });

  it('终局 / 没有表 / 截止时刻缺失都不显示', () => {
    expect(clockVisible('finished', { side: 1, deadlineAt: 1, remainingMs: 1 })).toBe(false);
    expect(clockVisible('playing', null)).toBe(false);
    expect(clockVisible('playing', { side: 1, deadlineAt: null, remainingMs: 30_000 })).toBe(false);
  });
});
