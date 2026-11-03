/**
 * 极简补间动画引擎。
 *
 * 为什么不直接用 gsap：落子只需要「一段位移 + 一段缩放回弹」两种曲线，
 * 自己实现约 100 行即可，既能省掉一个运行时依赖（gsap 压缩后仍有数十 KB），
 * 又能把缓动函数抽成纯函数单独做单元测试。
 *
 * 时间由调用方注入（`update(now)` 传入 `performance.now()`），
 * 因此不依赖真实时钟，测试里可以随意快进。
 */

/** 缓动函数：输入 0..1 的线性进度，输出 0..1 的缓动进度。 */
export type EasingFunction = (t: number) => number;

export const Easing = {
  linear: (t: number): number => t,

  /** 越到后面越慢，用于「恢复原状」这类收尾动作。 */
  easeOutCubic: (t: number): number => 1 - (1 - t) ** 3,

  /** 两头慢、中间快，适合相机推镜这类需要「起步柔和、收尾稳定」的运动。 */
  easeInOutCubic: (t: number): number =>
    t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,

  /**
   * 自由落体：位移与时间平方成正比，视觉上就是「越落越快」。
   * 这是落子动画的主曲线，比线性下落自然得多。
   */
  gravity: (t: number): number => t * t,

  /** 带一点过冲的收尾，适合需要「弹一下」的场合。 */
  easeOutBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
} satisfies Record<string, EasingFunction>;

export interface TweenInit {
  /** 时长（毫秒），小于等于 0 时立即完成。 */
  duration: number;
  /** 延迟开始（毫秒）。 */
  delay?: number;
  /** 缓动函数，默认线性。 */
  easing?: EasingFunction;
  /** 每帧回调，参数是已经过缓动的进度（0..1）。 */
  onUpdate: (progress: number) => void;
  /** 完成回调；可以在里面再 `add` 一段新动画形成串接。 */
  onComplete?: () => void;
}

/** 单条补间。`startedAt` 在第一帧才确定，避免「加入时间」与「首帧渲染时间」错位。 */
class Tween {
  private startedAt: number | null = null;
  private readonly duration: number;
  private readonly delay: number;
  private readonly easing: EasingFunction;
  private readonly onUpdate: (progress: number) => void;
  private readonly onComplete: (() => void) | undefined;

  constructor(init: TweenInit) {
    this.duration = Math.max(0, init.duration);
    this.delay = Math.max(0, init.delay ?? 0);
    this.easing = init.easing ?? Easing.linear;
    this.onUpdate = init.onUpdate;
    this.onComplete = init.onComplete;
  }

  /** 推进到 `now`，返回是否已结束。 */
  advance(now: number): boolean {
    if (this.startedAt === null) this.startedAt = now + this.delay;
    const elapsed = now - this.startedAt;
    if (elapsed < 0) return false;

    const linear = this.duration === 0 ? 1 : Math.min(1, elapsed / this.duration);
    this.onUpdate(this.easing(linear));

    if (linear < 1) return false;
    this.onComplete?.();
    return true;
  }
}

/**
 * 补间调度器：每帧由场景循环调用 `update()`，内部维护一个待执行队列。
 */
export class TweenManager {
  private readonly tweens: Tween[] = [];

  /** 追加一条补间。 */
  add(init: TweenInit): void {
    this.tweens.push(new Tween(init));
  }

  /**
   * 推进所有补间。
   *
   * 采用倒序遍历并即时删除，这样 `onComplete` 里追加的新补间会落到数组尾部，
   * 本轮不会被再次推进（避免同一帧内连续播放两段动画）。
   */
  update(now: number): void {
    for (let index = this.tweens.length - 1; index >= 0; index -= 1) {
      const tween = this.tweens[index];
      if (!tween) continue;
      if (tween.advance(now)) this.tweens.splice(index, 1);
    }
  }

  /** 丢弃所有补间（切换对局、组件销毁时调用）。 */
  clear(): void {
    this.tweens.length = 0;
  }

  /** 当前待执行的补间数量，便于调试与测试断言。 */
  get size(): number {
    return this.tweens.length;
  }
}
