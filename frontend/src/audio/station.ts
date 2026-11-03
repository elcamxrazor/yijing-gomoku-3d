/**
 * 电台时间轴的纯函数部分。
 *
 * 单独抽出来是为了能测：`「现在这一秒应该放哪首、放到第几秒」` 是整个功能里唯一
 * 容易算错的地方，而它只依赖几个数字，不该被 `<audio>` 和网络请求裹在里面。
 *
 * 关键设计：**不比较两台机器的绝对时钟**。
 * 一开始这里是「服务器时间 − 本机时间 = 偏移量」，看起来最直接，实际很脆：
 * 页面主线程但凡被卡住一段时间（3D 场景初始化、切后台、休眠唤醒），
 * `Date.now()` 就会比响应里的时间戳晚很多，偏移量直接歪掉几十秒，所有人错位。
 *
 * 改成「锚点 + 本机单调时钟」：从服务器拿一次 (第几首, 第几秒)，记下**本机**
 * 的 `performance.now()`，之后只用本机的差值往前走。跨机器只需要对齐一个点，
 * 不需要两个时钟同频。
 */

export interface TrackSpan {
  id: string;
  durationMs: number;
}

export interface Anchor {
  /** 锚点落在第几首 */
  index: number;
  /** 锚点那一刻，这首歌播到第几毫秒 */
  positionMs: number;
  /** 记录锚点时本机的 `performance.now()` */
  sampledAt: number;
}

export interface Position {
  index: number;
  positionMs: number;
}

/**
 * 从锚点往前走，算出现在应该放到第几首、第几秒。
 *
 * @param nowMs 本机 `performance.now()`；和 `anchor.sampledAt` 同一把尺子。
 */
export function locate(tracks: TrackSpan[], anchor: Anchor, nowMs: number): Position | null {
  if (tracks.length === 0) return null;
  let index = ((anchor.index % tracks.length) + tracks.length) % tracks.length;
  let position = anchor.positionMs + Math.max(0, nowMs - anchor.sampledAt);
  // 一首一首往前推；守卫是为了别在 duration 为 0 的坏数据上转死。
  for (let step = 0; step < tracks.length * 2; step += 1) {
    const track = tracks[index];
    if (!track || track.durationMs <= 0) break;
    if (position < track.durationMs) break;
    position -= track.durationMs;
    index = (index + 1) % tracks.length;
  }
  const track = tracks[index];
  if (!track) return null;
  return { index, positionMs: Math.min(Math.max(0, position), track.durationMs) };
}

/**
 * 滑杆位置 → 实际增益。
 *
 * `<audio>.volume` 是线性振幅，而听感接近对数：0.05 已经是 -26dB，听起来就有
 * 相当音量，于是整条滑杆可用的区间全挤在最左边（实测 5% 就够了）。取平方后
 * 50% ≈ -12dB、25% ≈ -24dB，低位才有细调的余地。
 */
export function perceivedGain(position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  return clamped * clamped;
}
