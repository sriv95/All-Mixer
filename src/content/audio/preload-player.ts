import type { Stem } from '../../shared/export';
import type { StemCache } from './stem-cache';

/** The cache may trail or lead the picture by this much before it is restarted at the player's position. */
const DRIFT_S = 0.08;
const CHECK_MS = 500;
/** Scheduling margin so the sources start together, in the future. */
const PREROLL_S = 0.02;
/** A cache of a video and an ad differ by more than this in length. */
export const SAME_LENGTH_S = 0.5;
const EVENTS = ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended', 'emptied'] as const;

/**
 * Plays a StemCache in step with a <video>: one AudioBufferSourceNode per stem, through its own gain, into `out`.
 * It starts at the player's position on play / seek, stops on pause / seek / wait, and restarts when the two clocks drift apart.
 * Only plays at 1× (the sources would change pitch with the speed).
 */
export class PreloadPlayer {
  private readonly gains = new Map<Stem, GainNode>();
  private sources: AudioBufferSourceNode[] = [];
  private anchor = { ctx: 0, media: 0 };
  private active = false;
  /** Taps every stem: the level of what the cache plays, for the status (QA). */
  private readonly meter: AnalyserNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly sync = () => {
    this.stop();
    if (this.canPlay()) this.start();
  };

  constructor(
    private readonly ctx: AudioContext,
    out: AudioNode,
    private readonly video: HTMLMediaElement,
    private readonly cache: StemCache,
  ) {
    this.meter = new AnalyserNode(ctx, { fftSize: 2048 });
    this.samples = new Float32Array(this.meter.fftSize);
    for (const id of cache.buffers.keys()) {
      const g = new GainNode(ctx, { gain: 0 });
      g.connect(out);
      g.connect(this.meter);
      this.gains.set(id, g);
    }
    for (const e of EVENTS) video.addEventListener(e, this.sync);
    ctx.addEventListener('statechange', this.sync);
    this.timer = setInterval(() => this.check(), CHECK_MS);
  }

  /** Whether the cache is what plays for this video right now. */
  static fits(cache: StemCache, video: HTMLMediaElement, key: string): boolean {
    return cache.key === key && Math.abs(video.duration - cache.duration) < SAME_LENGTH_S && video.playbackRate === 1;
  }

  setLevels(levels: Partial<Record<Stem, number>>): void {
    for (const [id, g] of this.gains) g.gain.setTargetAtTime(levels[id] ?? 0, this.ctx.currentTime, 0.015);
  }

  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    this.sync();
  }

  get playing(): boolean {
    return this.sources.length > 0;
  }

  /** Peak (0–1) of the last 2048 samples the cache played. */
  level(): number {
    this.meter.getFloatTimeDomainData(this.samples);
    return this.samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  }

  /** How far the cache is behind (positive) the video, ms; null when it does not play. */
  driftMs(): number | null {
    if (!this.playing) return null;
    return (this.video.currentTime - (this.anchor.media + (this.ctx.currentTime - this.anchor.ctx))) * 1000;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stop();
    for (const e of EVENTS) this.video.removeEventListener(e, this.sync);
    this.ctx.removeEventListener('statechange', this.sync);
    for (const g of this.gains.values()) g.disconnect();
    this.gains.clear();
  }

  private canPlay(): boolean {
    const v = this.video;
    return this.active && this.ctx.state === 'running' && !v.paused && !v.seeking && !v.ended && v.readyState >= 3 && v.playbackRate === 1 && v.currentTime < this.cache.duration;
  }

  private start(): void {
    const when = this.ctx.currentTime + PREROLL_S;
    const at = this.video.currentTime + PREROLL_S; // the picture moves on while the sources wait for `when`
    this.anchor = { ctx: when, media: at };
    for (const [id, buffer] of this.cache.buffers) {
      const src = new AudioBufferSourceNode(this.ctx, { buffer });
      src.connect(this.gains.get(id)!);
      src.start(when, at);
      this.sources.push(src);
    }
  }

  private stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    this.sources = [];
  }

  private check(): void {
    if (!this.playing) return this.sync(); // e.g. the video was not ready when play came
    const expected = this.anchor.media + (this.ctx.currentTime - this.anchor.ctx);
    if (!this.canPlay() || Math.abs(this.video.currentTime - expected) > DRIFT_S) this.sync();
  }
}
