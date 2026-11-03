import { describe, expect, it } from 'vitest';
import { Easing, TweenManager } from './tween';

describe('Easing', () => {
  const easings = Object.entries(Easing);

  it.each(easings)('%s 的起点与终点都必须精确落在 0 和 1', (_name, ease) => {
    expect(ease(0)).toBeCloseTo(0, 10);
    expect(ease(1)).toBeCloseTo(1, 10);
  });

  it('gravity 等价于 t²，呈现加速下落', () => {
    expect(Easing.gravity(0.5)).toBeCloseTo(0.25, 10);
    expect(Easing.gravity(0.9)).toBeGreaterThan(Easing.gravity(0.5));
  });

  it('easeOutCubic 先快后慢', () => {
    expect(Easing.easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('TweenManager', () => {
  it('按时间推进并在结束时回调一次', () => {
    const manager = new TweenManager();
    const seen: number[] = [];
    let completed = 0;

    manager.add({
      duration: 100,
      onUpdate: (p) => seen.push(p),
      onComplete: () => { completed += 1; },
    });

    manager.update(1000); // 第一帧确定起点
    manager.update(1050);
    manager.update(1100);
    manager.update(1200);

    expect(completed).toBe(1);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect(manager.size).toBe(0);
  });

  it('delay 期间不推进', () => {
    const manager = new TweenManager();
    const seen: number[] = [];
    manager.add({ duration: 100, delay: 200, onUpdate: (p) => seen.push(p) });

    manager.update(0);
    manager.update(100); // 仍在延迟内
    expect(seen).toHaveLength(0);

    manager.update(250);
    expect(seen[0]).toBeCloseTo(0.5, 5);
  });

  it('onComplete 里追加的补间要等到下一帧才开始', () => {
    const manager = new TweenManager();
    const order: string[] = [];

    manager.add({
      duration: 100,
      onUpdate: () => undefined,
      onComplete: () => {
        order.push('fall');
        // 模拟落地后接一段回弹
        manager.add({
          duration: 100,
          onUpdate: () => undefined,
          onComplete: () => order.push('squash'),
        });
      },
    });

    manager.update(0);
    manager.update(100); // 第一段结束，第二段入队但本轮不再推进
    expect(order).toEqual(['fall']);
    expect(manager.size).toBe(1);

    manager.update(200); // 第二段的第一帧：确定起点，进度仍是 0
    expect(order).toEqual(['fall']);

    manager.update(300); // 第二段跑满 100ms
    expect(order).toEqual(['fall', 'squash']);
  });

  it('duration 为 0 时当帧立即完成', () => {
    const manager = new TweenManager();
    let completed = false;
    manager.add({ duration: 0, onUpdate: () => undefined, onComplete: () => { completed = true; } });
    manager.update(10);
    expect(completed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it('clear 丢弃所有未完成的补间', () => {
    const manager = new TweenManager();
    manager.add({ duration: 100, onUpdate: () => undefined });
    manager.add({ duration: 100, onUpdate: () => undefined });
    expect(manager.size).toBe(2);
    manager.clear();
    expect(manager.size).toBe(0);
  });
});
