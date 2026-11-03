/**
 * 网络电台客户端：不是一个播放器，是一台接收机。
 *
 * 服务器手里有一条排期（曲目顺序 + 每首时长 + 这一轮的起点），「现在放到第几首、
 * 第几秒」对所有人是同一个答案。这里的职责不是「播我的列表」，而是「把自己对齐
 * 到那个位置」：
 *
 * 1. **加入**：第一次交互时不从第 0 秒开始，而是问一次服务器「现在到哪了」，
 *    直接切进去——调频收音机就是这个体验，你打开时歌已经在唱了。
 * 2. **续播**：一首放完，从锚点往前走算出下一首该从第几秒开始，而不是简单从头播。
 * 3. **校准**：每 30 秒对一次表（顺便发现曲库被改了）；本地偏差超过 2.5 秒才打断。
 *
 * 时间轴只看本机的单调时钟，不比较两台机器的绝对时间——原因见 `station.ts` 顶部。
 *
 * 另外：浏览器不允许无手势自动播放，所以播放器先「待命」，**只有点电台按钮
 * 那一下**才会把它接上。页面里其它的点击（落子、切弹窗）一概不碰播放：
 * 来下棋的人不该被背景音乐突袭。
 */

import { locate, perceivedGain, type Anchor, type Position } from './station';

const STORAGE_KEY = 'yijing-radio';
const DEFAULT_VOLUME = 0.6;
/** 与服务器时间轴差到这个量才值得打断播放去修正 */
const DRIFT_TOLERANCE_MS = 2500;
/** 定期校准；也是「曲库被改了」的发现机制 */
const RESYNC_INTERVAL_MS = 30_000;

export interface RadioTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
}

export interface RadioState {
  /** 曲库里有歌。为假时前端不显示电台入口。 */
  enabled: boolean;
  /** 用户点过电台按钮（播放只在这次手势里被允许启动）。 */
  started: boolean;
  /** 真的在出声（没暂停、没被浏览器拦下）。 */
  playing: boolean;
  muted: boolean;
  /** 滑杆位置 0 ~ 1（不是增益，见 perceivedGain） */
  volume: number;
  title: string | null;
  artist: string | null;
}

interface StationPayload {
  startedAtMs?: unknown;
  serverNowMs?: unknown;
  totalMs?: unknown;
  trackId?: unknown;
  positionMs?: unknown;
  trackCount?: unknown;
}

interface StoredSettings {
  /** 存储格式版本。1（或缺失）表示存的是线性振幅，2 表示存的是滑杆位置。 */
  v?: number;
  volume?: number;
  muted?: boolean;
}

export class Radio {
  private readonly audio = new Audio();
  private readonly baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
  private tracks: RadioTrack[] = [];
  private index = 0;
  private anchor: Anchor | null = null;
  private currentUrl = '';
  private pendingSeekMs: number | null = null;
  private broken = new Set<string>();
  private failures = 0;
  private playing = false;
  private muted = false;
  private volume = DEFAULT_VOLUME;
  private onChange: ((state: RadioState) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * 用户是否点过电台按钮。
   *
   * 以前是「页面任意一次点击就起播」，那等于没得选：来页面是为了下棋，
   * 不是来听歌的。现在只有**点电台按钮**这一个入口，别的点击一律不碰播放。
   */
  private started = false;

  constructor() {
    this.restore();
    this.audio.preload = 'auto';
    // 挂进文档（无 controls，不占位）：不这么做它就是个游离对象，
    // 调试与自动化都碰不到 currentTime。
    this.audio.hidden = true;
    document.body.append(this.audio);
    this.applyVolume();
    this.audio.muted = this.muted;
    this.audio.addEventListener('playing', () => {
      this.playing = true;
      this.failures = 0;
      this.emit();
    });
    this.audio.addEventListener('pause', () => {
      this.playing = false;
      this.emit();
    });
    this.audio.addEventListener('loadedmetadata', () => this.applyPendingSeek());
    this.audio.addEventListener('ended', () => this.syncToStation(true));
    this.audio.addEventListener('error', () => this.handleError());
  }

  /** 订阅状态变化。只有一个消费者（界面渲染），所以不维护监听器集合。 */
  observe(listener: (state: RadioState) => void): void {
    this.onChange = listener;
    listener(this.state());
  }

  /**
   * 开始收听。**必须在点击事件里同步调用**：浏览器只认手势调用栈里的 `play()`，
   * 晚一步（比如等一个 await 回来）就会被拦下。
   */
  begin(): void {
    const first = !this.started;
    this.started = true;
    if (first) {
      this.joinIfReady();
      this.emit();
      return;
    }
    // 已经点过一次（比如浏览器之前拦了）：再点一下当作「继续」。
    if (!this.playing) this.joinIfReady();
  }

  state(): RadioState {
    const track = this.tracks[this.index];
    return {
      enabled: this.tracks.length > 0,
      started: this.started,
      playing: this.playing,
      muted: this.muted,
      volume: this.volume,
      title: track?.title ?? null,
      artist: track?.artist ? track.artist : null,
    };
  }

  /** 拉曲库与锚点。失败（离线、后端未配置）时返回 false，界面据此隐藏入口。 */
  async load(): Promise<boolean> {
    const ok = await this.fetchLibrary();
    if (ok && this.started) this.joinIfReady();
    return ok;
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    this.applyVolume();
    // 拖音量通常意味着「我想听见」，顺便解除静音，免得拖了个寂寞。
    if (this.volume > 0 && this.muted) {
      this.muted = false;
      this.audio.muted = false;
    }
    this.persist();
    this.emit();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.audio.muted = this.muted;
    this.persist();
    this.emit();
  }

  // ------------------------------------------------------------------
  // 音量
  // ------------------------------------------------------------------
  private applyVolume(): void {
    this.audio.volume = perceivedGain(this.volume);
  }

  // ------------------------------------------------------------------
  // 时间轴
  // ------------------------------------------------------------------
  private positionAt(nowMs: number): Position | null {
    if (!this.anchor) return null;
    return locate(this.tracks, this.anchor, nowMs);
  }

  /** 把播放位置拉回服务器时间轴。force=false 时只在小偏差内放过。 */
  private syncToStation(force = false): void {
    const target = this.positionAt(performance.now());
    if (!target) return;
    const drift = this.index === target.index
      ? Math.abs(this.audio.currentTime * 1000 - target.positionMs)
      : Number.POSITIVE_INFINITY;
    if (!force && drift < DRIFT_TOLERANCE_MS) return;
    this.playAt(target.index, target.positionMs);
  }

  private playAt(index: number, positionMs: number): void {
    const track = this.tracks[index];
    if (!track) return;
    if (this.broken.has(track.id) && this.broken.size < this.tracks.length) {
      // 这一首放不出来（文件坏了/编码不支持），先跳到下一首，
      // 不让所有人卡在同一个死文件上。时钟走过这一段后会自动回到正轨。
      this.playAt((index + 1) % this.tracks.length, 0);
      return;
    }
    this.index = index;
    const url = `${this.baseUrl}/api/radio/${encodeURIComponent(track.id)}`;
    const seconds = Math.max(0, positionMs / 1000);
    if (this.currentUrl !== url) {
      this.currentUrl = url;
      this.pendingSeekMs = positionMs;
      this.audio.src = url;
    } else if (this.audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      // 元数据还没到，改 currentTime 会被浏览器忽略；记下来等 loadedmetadata。
      // 这里必须**覆盖**旧的待定值：加入时先按旧锚点起播、紧接着对表修正，
      // 两次 seek 之间元数据往往还没到，留下旧值就会把播放位置拽回原处。
      this.pendingSeekMs = positionMs;
    } else if (Math.abs(this.audio.currentTime - seconds) > 0.4) {
      this.audio.currentTime = this.clampSeek(seconds);
    }
    this.emit();
    void this.tryPlay();
  }

  private clampSeek(seconds: number): number {
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, seconds);
    return Math.min(Math.max(0, seconds), Math.max(0, duration - 0.15));
  }

  private applyPendingSeek(): void {
    const pending = this.pendingSeekMs;
    if (pending === null) return;
    this.pendingSeekMs = null;
    this.audio.currentTime = this.clampSeek(pending / 1000);
  }

  // ------------------------------------------------------------------
  // 调度
  // ------------------------------------------------------------------
  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => void this.resync(), RESYNC_INTERVAL_MS);
  }

  /** 定期对表：曲库换了吗？现在该放到哪了？ */
  private async resync(): Promise<void> {
    if (!this.anchor) return;
    const startedAt = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/radio/state`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const data = (await response.json()) as StationPayload;
      const sampledAt = performance.now();
      if (typeof data.trackId !== 'string' || typeof data.positionMs !== 'number') return;
      const trackCount = typeof data.trackCount === 'number' ? data.trackCount : this.tracks.length;
      const trackIndex = this.tracks.findIndex((track) => track.id === data.trackId);
      if (trackCount !== this.tracks.length || trackIndex < 0) {
        // 排期变了（有人往目录里加了歌，或换了整个曲库），整张表都要换。
        this.broken.clear();
        if (await this.fetchLibrary()) this.syncToStation(true);
        return;
      }
      this.anchor = {
        index: trackIndex,
        // 采样经过了一个来回，加上一半的单向延迟更准。
        positionMs: data.positionMs + (sampledAt - startedAt) / 2,
        sampledAt,
      };
      this.syncToStation();
    } catch {
      // 网络抖一下不是故障，下一个周期再对。
    }
  }

  private async fetchLibrary(): Promise<boolean> {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/radio`, { credentials: 'same-origin' });
      if (!response.ok) return false;
      const data: unknown = await response.json();
      const sampledAt = performance.now();
      if (!data || typeof data !== 'object') return false;
      const payload = data as { tracks?: unknown; station?: unknown };
      if (!Array.isArray(payload.tracks)) return false;

      const tracks: RadioTrack[] = [];
      for (const item of payload.tracks) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as Partial<RadioTrack>;
        if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') continue;
        tracks.push({
          id: candidate.id,
          title: candidate.title,
          artist: typeof candidate.artist === 'string' ? candidate.artist : '',
          durationMs: typeof candidate.durationMs === 'number' && candidate.durationMs > 0
            ? candidate.durationMs
            : 1000,
        });
      }
      if (tracks.length === 0) return false;

      const station = (payload.station && typeof payload.station === 'object'
        ? payload.station
        : null) as StationPayload | null;
      const trackId = typeof station?.trackId === 'string' ? station.trackId : '';
      const positionMs = typeof station?.positionMs === 'number' ? station.positionMs : 0;
      const index = tracks.findIndex((track) => track.id === trackId);
      if (index < 0) return false;

      this.tracks = tracks;
      this.anchor = {
        index,
        positionMs: Math.max(0, positionMs + (sampledAt - startedAt) / 2),
        sampledAt,
      };
      this.index = index;
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // 起播
  // ------------------------------------------------------------------
  /**
   * 有了手势、也有了锚点，才真正加入。
   *
   * 曲库可能比用户的点击更晚到（fetch 还没回来），所以 `begin()` 与
   * `load()` 两边都会调它，谁后到谁负责接上。
   */
  private joinIfReady(): void {
    if (!this.started) return;
    if (!this.anchor || this.playing || this.tracks.length === 0) return;
    // 先用手上这个锚点起播：`play()` 要落在手势的调用栈里，Safari 只认这种。
    this.syncToStation(true);
    this.startTimer();
    // 然后立刻对一次表。曲库那份锚点可能是页面刚起来时取的，中间主线程被
    // 3D 初始化堵过一段时间的话，它会偏几十秒——这一次请求几乎无延迟，
    // 能把位置拉回正轨。
    void this.resync();
  }

  private async tryPlay(): Promise<void> {
    if (this.tracks.length === 0) return;
    try {
      await this.audio.play();
    } catch {
      // 没有手势、或被策略挡住：保持待命，等下一次交互。
    }
  }

  private handleError(): void {
    const track = this.tracks[this.index];
    if (!track) return;
    // 出过错就先丢掉待定的 seek，否则这个字段会一直等一个永远不会来的
    // loadedmetadata（404 的文件正是这样），整条跳转逻辑就卡死了。
    this.pendingSeekMs = null;
    this.broken.add(track.id);
    this.failures += 1;
    if (this.failures >= this.tracks.length) {
      // 整轮都放不出来：服务器挂了或编码全不支持，停下来，别再空转。
      this.playing = false;
      this.emit();
      return;
    }
    this.playAt((this.index + 1) % this.tracks.length, 0);
  }

  // ------------------------------------------------------------------
  // 持久化
  // ------------------------------------------------------------------
  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredSettings;
      if (typeof stored.volume === 'number' && Number.isFinite(stored.volume)) {
        this.volume = Math.min(1, Math.max(0, stored.volume));
      }
      if (stored.v !== 2) {
        // 旧版本存的是线性振幅（滑杆位置就是增益）。换成新曲线后如果原样读入，
        // 原来调好的音量会瞬间变得几乎听不见；开方正是平方的逆运算，
        // 换算后的增益与升级前一致，只是滑杆位置变大了、两边都留出了余量。
        this.volume = Math.sqrt(this.volume);
      }
      if (typeof stored.muted === 'boolean') this.muted = stored.muted;
    } catch {
      // 存储被禁或内容损坏时用默认值，不影响播放。
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, volume: this.volume, muted: this.muted }));
    } catch {
      // 隐私模式下写不进去，忽略即可。
    }
  }

  private emit(): void {
    this.onChange?.(this.state());
  }
}
