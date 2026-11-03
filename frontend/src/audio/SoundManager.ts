export type SoundName = 'black' | 'white' | 'victory' | 'error' | 'join' | 'bell';

export class SoundManager {
  private context: AudioContext | null = null;
  private muted = localStorage.getItem('yijing-muted') === 'true';

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('yijing-muted', String(this.muted));
    if (!this.muted) void this.ensureContext()?.resume();
    return this.muted;
  }

  play(name: SoundName): void {
    if (this.muted) return;
    const context = this.ensureContext();
    if (!context) return;
    void context.resume();
    const now = context.currentTime;
    if (name === 'victory') {
      [261.63, 329.63, 392, 523.25].forEach((frequency, index) => {
        this.tone(frequency, now + index * 0.11, 0.65, 0.055, 'sine');
      });
      return;
    }
    if (name === 'error') {
      this.tone(155, now, 0.18, 0.045, 'triangle', 118);
      return;
    }
    if (name === 'join') {
      this.tone(392, now, 0.25, 0.035, 'sine');
      this.tone(523.25, now + 0.08, 0.32, 0.025, 'sine');
      return;
    }
    if (name === 'bell') {
      // 钟的泛音是**不和谐**的：2.76、5.4、8.93 倍这几个数字来自真实钟体
      // 的振动模态，用整倍数会听成门铃。衰减也分开算——高次泛音先消失，
      // 留下的是那一声余韵。
      const base = 660;
      const partials = [1, 2.76, 5.4, 8.93];
      partials.forEach((ratio, index) => {
        this.tone(
          base * ratio,
          now,
          1.6 / (1 + index * 0.85),
          0.055 / (1 + index * 1.5),
          'sine',
          undefined,
          7200,
        );
      });
      return;
    }
    const base = name === 'black' ? 185 : 235;
    this.tone(base, now, 0.12, 0.07, 'sine', base * 0.72);
    this.tone(base * 2.7, now, 0.055, 0.018, 'triangle', base * 1.8);
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return null;
    this.context = new AudioContextConstructor();
    return this.context;
  }

  private tone(
    frequency: number,
    start: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    endFrequency?: number,
    brightness = 1800,
  ): void {
    if (!this.context) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    filter.type = 'lowpass';
    filter.frequency.value = brightness;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(filter).connect(gain).connect(this.context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
}
