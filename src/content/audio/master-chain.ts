import type { AudioState } from '../../shared/messages';
import { createLimiter } from './limiter';

/**
 * Default-mode audio path:
 *   <video> → MediaElementSource → GainNode (0–6×) → limiter → destination
 *
 * The page's audio is left untouched until a non-unity gain is first requested.
 * After that the element stays routed through the graph (Web Audio cannot undo
 * createMediaElementSource), and 100 % is just unity gain.
 *
 * A MediaElementSource on a suspended AudioContext would mute the video, so we
 * only connect once the context is actually running. Chrome's autoplay policy
 * may need a click or key press on the page first; we listen for one.
 */
export class MasterChain {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private video: HTMLMediaElement | null = null;
  private targetGain = 1;
  private engaged = false;
  private lastError: string | undefined;
  private removeGestureListeners: (() => void) | null = null;

  constructor(private readonly onStateChange: () => void = () => {}) {}

  get state(): AudioState {
    if (this.lastError) return 'error';
    if (!this.engaged) return 'idle';
    if (this.ctx?.state !== 'running') return 'waiting-for-gesture';
    return this.video && this.sources.has(this.video) ? 'active' : 'idle';
  }

  /** Gain currently requested for the master stage (linear). */
  get requestedGain(): number {
    return this.targetGain;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  setVideo(video: HTMLMediaElement): void {
    this.video = video;
    if (this.engaged) this.connectIfReady();
  }

  setGain(linear: number): void {
    this.targetGain = linear;
    if (!this.engaged && linear !== 1) this.engage();
    if (this.ctx && this.gain) {
      this.gain.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.015);
    }
  }

  private engage(): void {
    this.engaged = true;
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const gain = new GainNode(ctx, { gain: this.targetGain });
      const limiter = createLimiter(ctx);
      gain.connect(limiter.input);
      limiter.output.connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
      ctx.addEventListener('statechange', () => {
        this.connectIfReady();
        this.onStateChange();
      });
    } catch (e) {
      this.fail(e);
      return;
    }
    this.connectIfReady();
  }

  private connectIfReady(): void {
    const { ctx, gain, video } = this;
    if (!ctx || !gain) return;
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      this.listenForGesture();
      return;
    }
    this.stopListeningForGesture();
    if (!video || this.sources.has(video)) return;
    try {
      const source = ctx.createMediaElementSource(video);
      source.connect(gain);
      this.sources.set(video, source);
      this.lastError = undefined;
    } catch (e) {
      // Typically: another extension already owns this element's audio.
      this.fail(e);
    }
    this.onStateChange();
  }

  private listenForGesture(): void {
    if (this.removeGestureListeners) return;
    const resume = () => {
      void this.ctx?.resume().then(() => this.connectIfReady(), () => {});
    };
    const opts = { capture: true, passive: true } as const;
    const events = ['pointerdown', 'keydown'] as const;
    for (const e of events) window.addEventListener(e, resume, opts);
    this.video?.addEventListener('play', resume);
    const video = this.video;
    this.removeGestureListeners = () => {
      for (const e of events) window.removeEventListener(e, resume, opts);
      video?.removeEventListener('play', resume);
    };
  }

  private stopListeningForGesture(): void {
    this.removeGestureListeners?.();
    this.removeGestureListeners = null;
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    console.warn('[All Mixer!] audio error:', e);
    this.onStateChange();
  }
}
