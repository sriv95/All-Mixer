import type { AudioState } from '../../shared/messages';
import type { SeparationQuality } from '../../shared/settings';
import {
  DSP_LATENCY_SAMPLES,
  ML_LATENCY_SAMPLES,
  ML_SAMPLE_RATE,
  PARAM_INSTRUMENTAL,
  PARAM_VOCAL,
  SEPARATOR_MODULE_PATH,
  SEPARATOR_PROCESSOR,
  type FromWorklet,
  type MlEngine,
  type MlReason,
  type ToWorklet,
} from '../../worklet/protocol';
import { toPerformanceTime, type EngineReason, type LatencyInfo, type LatencyListener } from './latency';
import { createLimiter } from './limiter';

/**
 * Audio graph for both modes:
 *
 *   <video> → MediaElementSource ─┬─ direct (gain) ───────────────────────┬→ master (0–6×) → limiter → destination
 *                                 └─ separator worklet (vocal/inst 0–6×) ─ sepOut (gain) ┘
 *
 * Default mode plays through `direct` with no added delay. Separate mode
 * crossfades to the separator, whose output is DSP_LATENCY_SAMPLES late (ML_LATENCY_SAMPLES
 * in the ML engine, which the worklet reports with an `engine` message); the
 * crossfade starts once the separator has primed, so there is no gap. The
 * worklet module is only loaded the first time Separate mode is used.
 *
 * The page's audio is left untouched until a non-unity gain or Separate mode is
 * first requested. After that the element stays routed through the graph (Web
 * Audio cannot undo createMediaElementSource), and 100 % is just unity gain.
 *
 * A MediaElementSource on a suspended AudioContext would mute the video, so we
 * only connect once the context is actually running. Chrome's autoplay policy
 * may need a click or key press on the page first; we listen for one.
 */

export interface SeparationRequest {
  on: boolean;
  /** Linear gains, 0–6. */
  vocal: number;
  instrumental: number;
  quality: SeparationQuality;
}

export type SeparationState = 'off' | 'loading' | 'on' | 'error';

/** Crossfade time constant (s); settles in ≈ 30 ms. */
const FADE_TAU = 0.006;
/** Margin between scheduling and the start of a ramp (s). */
const PRE_ROLL = 0.01;
/** Gain slider smoothing (s). */
const GAIN_TAU = 0.015;
const DEVICE_POLL_MS = 2000;
/** Device latency moves smaller than this are jitter, not a change. */
const DEVICE_STEP_MS = 2;

const OFF: SeparationRequest = { on: false, vocal: 1, instrumental: 1, quality: 'auto' };

/** Set on the element when we route its audio. The DOM is shared, so another copy of the extension sees it. */
export const OWNER_ATTR = 'data-all-mixer-audio';

export const ERR_OTHER_COPY =
  'Another copy of All Mixer! already controls this video. Turn off the other copy in chrome://extensions, then reload the page.';
export const ERR_OTHER_OWNER =
  "Another extension or script already controls this video's audio. Turn it off for YouTube, then reload the page.";

export class MasterChain {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private direct: GainNode | null = null;
  private sepOut: GainNode | null = null;
  private sep: AudioWorkletNode | null = null;
  private sepLoading = false;
  private sepError: string | undefined;
  /** Separator output is (or is fading to be) what we hear. */
  private separating = false;
  /** Worklet is running the separator (stays on briefly after a fade-out). */
  private workletOn = false;
  /** Engine the worklet runs, and why (kept in step with its `engine` messages). */
  private engine: MlEngine = 'dsp';
  private engineReason: EngineReason = 'auto';
  private pendingMlPort: MessagePort | null = null;
  private pendingEngine: { engine: MlEngine; reason: MlReason } | null = null;
  private offTimer: ReturnType<typeof setTimeout> | undefined;
  private separation: SeparationRequest = OFF;
  private readonly listeners = new Set<LatencyListener>();
  private lastDeviceMs = 0;
  private readonly sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private video: HTMLMediaElement | null = null;
  private targetGain = 1;
  private engaged = false;
  private lastError: string | undefined;
  private removeGestureListeners: (() => void) | null = null;
  private readonly onSeeking = () => this.flush();
  private readonly instanceId = Math.random().toString(36).slice(2);

  constructor(
    private readonly onStateChange: () => void = () => {},
    private readonly workletUrl: () => string = () => chrome.runtime.getURL(SEPARATOR_MODULE_PATH),
  ) {}

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

  /** Output delay the device adds, ms; 0 without a running context. */
  get deviceLatencyMs(): number {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return 0;
    return ((ctx.baseLatency || 0) + ((ctx as { outputLatency?: number }).outputLatency || 0)) * 1000;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get separationState(): SeparationState {
    if (this.sepError) return 'error';
    if (!this.separation.on) return 'off';
    return this.separating ? 'on' : 'loading';
  }

  get separationError(): string | undefined {
    return this.sepError;
  }

  /** Current total audio delay (D1). */
  get latency(): LatencyInfo {
    const sampleRate = this.ctx?.sampleRate ?? 48000;
    const processingSamples = !this.separating ? 0 : this.engine === 'ml' ? ML_LATENCY_SAMPLES : DSP_LATENCY_SAMPLES;
    const processingMs = (processingSamples / sampleRate) * 1000;
    const deviceMs = this.deviceLatencyMs;
    return {
      engine: this.separating ? this.engine : 'bypass',
      reason: this.separating ? this.engineReason : this.separation.quality === 'light' ? 'user' : 'auto',
      sampleRate,
      processingSamples,
      processingMs,
      deviceMs,
      videoDelayMs: processingMs + deviceMs,
    };
  }

  /** Subscribe to delay changes; returns the unsubscribe function. */
  onLatencyChange(cb: LatencyListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Drop audio buffered in the separator (seeks call this automatically). */
  flush(): void {
    if (this.workletOn) this.post({ type: 'flush' });
  }

  /** Hand the worklet its channel to the ML worker (the port is transferred). */
  setMlPort(port: MessagePort): void {
    if (!this.sep) {
      this.pendingMlPort = port; // delivered once the worklet module has loaded
      return;
    }
    this.sep.port.postMessage({ type: 'ml-port', port } satisfies ToWorklet, [port]);
  }

  /** True when the graph can run the ML engine (context at the model rate, or not built yet). */
  canRunMl(): boolean {
    return !this.ctx || this.ctx.sampleRate === ML_SAMPLE_RATE;
  }

  /** Switch engine while separating. The worklet confirms with an `engine` message (and the delay event). */
  setEngine(engine: MlEngine, reason: MlReason): boolean {
    if (engine === 'dsp') this.pendingEngine = null;
    // The model has no resampler: ML only runs when the context is at the model rate.
    if (engine === 'ml' && this.ctx?.sampleRate !== ML_SAMPLE_RATE) return false;
    if (this.workletOn) this.post({ type: 'engine', engine, reason });
    else this.pendingEngine = { engine, reason }; // applied once the separator has started
    return true;
  }

  setVideo(video: HTMLMediaElement): void {
    if (this.video !== video) {
      this.video?.removeEventListener('seeking', this.onSeeking);
      video.addEventListener('seeking', this.onSeeking);
    }
    this.video = video;
    if (this.engaged) this.connectIfReady();
  }

  setGain(linear: number): void {
    this.targetGain = linear;
    if (!this.engaged && linear !== 1) this.engage();
    if (this.ctx && this.gain) {
      this.gain.gain.setTargetAtTime(linear, this.ctx.currentTime, GAIN_TAU);
    }
  }

  setSeparation(req: SeparationRequest): void {
    this.separation = { ...req };
    if (!req.on) {
      // Nothing may leak into the next turn-on: the host that owned this port is gone.
      this.pendingEngine = null;
      this.pendingMlPort?.close();
      this.pendingMlPort = null;
    }
    if (!this.engaged && req.on) this.engage();
    this.route();
  }

  private engage(): void {
    this.engaged = true;
    try {
      // Always the model rate, whatever the quality setting: the worklet needs no resampler and
      // switching Light -> Auto in the same tab can still run ML. Chrome resamples at the output.
      const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: ML_SAMPLE_RATE });
      const gain = new GainNode(ctx, { gain: this.targetGain });
      const limiter = createLimiter(ctx);
      gain.connect(limiter.input);
      limiter.output.connect(ctx.destination);
      this.direct = new GainNode(ctx, { gain: 1 });
      this.sepOut = new GainNode(ctx, { gain: 0 });
      this.direct.connect(gain);
      this.sepOut.connect(gain);
      this.ctx = ctx;
      this.gain = gain;
      ctx.addEventListener('statechange', () => {
        this.connectIfReady();
        this.checkDeviceLatency();
        this.onStateChange();
      });
      // outputLatency changes at run time, e.g. when Bluetooth headphones connect.
      setInterval(() => this.checkDeviceLatency(), DEVICE_POLL_MS);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.connectIfReady();
  }

  /** Bring the graph in line with `this.separation`. */
  private route(): void {
    const { ctx, sep, direct, sepOut } = this;
    if (!ctx || !direct || !sepOut) return;
    const want = this.separation.on && !this.sepError;
    if (want && !sep) {
      this.loadSeparator(); // keeps playing through `direct` meanwhile
      return;
    }
    if (!sep) return;
    const now = ctx.currentTime;
    if (want) {
      sep.parameters.get(PARAM_VOCAL)?.setTargetAtTime(this.separation.vocal, now, GAIN_TAU);
      sep.parameters.get(PARAM_INSTRUMENTAL)?.setTargetAtTime(this.separation.instrumental, now, GAIN_TAU);
      if (this.separating) return;
      clearTimeout(this.offTimer);
      let start = now + PRE_ROLL;
      if (!this.workletOn) {
        // A fresh separator outputs silence for its first DSP_LATENCY_SAMPLES; fade in after that.
        this.engine = 'dsp';
        this.engineReason = 'auto';
        this.post({ type: 'active', on: true });
        this.workletOn = true;
        if (this.pendingEngine) this.post({ type: 'engine', ...this.pendingEngine });
        this.pendingEngine = null;
        start += DSP_LATENCY_SAMPLES / ctx.sampleRate;
      }
      this.crossfade(sepOut, direct, start);
      this.separating = true;
      this.emitLatency(start);
    } else if (this.separating) {
      const start = now + PRE_ROLL;
      this.crossfade(direct, sepOut, start);
      this.separating = false;
      this.emitLatency(start);
      // Stop the separator (and its CPU cost) once the fade-out has settled.
      const offMs = (PRE_ROLL + 10 * FADE_TAU) * 1000 + 50;
      this.offTimer = setTimeout(() => {
        if (this.separating) return;
        this.post({ type: 'active', on: false });
        this.workletOn = false;
      }, offMs);
    }
    this.onStateChange();
  }

  private crossfade(fadeIn: GainNode, fadeOut: GainNode, start: number): void {
    const now = this.ctx!.currentTime;
    for (const [node, target] of [
      [fadeIn, 1],
      [fadeOut, 0],
    ] as const) {
      node.gain.cancelScheduledValues(now);
      node.gain.setTargetAtTime(target, start, FADE_TAU);
    }
  }

  private loadSeparator(): void {
    const ctx = this.ctx;
    if (!ctx || this.sepLoading) return;
    this.sepLoading = true;
    this.onStateChange();
    ctx.audioWorklet
      .addModule(this.workletUrl())
      .then(() => {
        const node = new AudioWorkletNode(ctx, SEPARATOR_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          // Mono sources are up-mixed so the separator always sees L/R.
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onWorkletMessage(e.data);
        node.addEventListener('processorerror', () => this.failSeparation(new Error('separator stopped')));
        node.connect(this.sepOut!);
        const source = this.video && this.sources.get(this.video);
        source?.connect(node);
        this.sep = node;
        if (this.pendingMlPort) {
          const port = this.pendingMlPort;
          this.pendingMlPort = null;
          this.setMlPort(port);
        }
        this.route();
      })
      .catch((e: unknown) => this.failSeparation(e));
  }

  private failSeparation(e: unknown): void {
    this.sepError = e instanceof Error ? e.message : String(e);
    console.warn('[All Mixer!] separation unavailable, playing the original mix:', e);
    this.route(); // fades back to `direct` if we were separating
    this.onStateChange();
  }

  private onWorkletMessage(msg: FromWorklet): void {
    if (msg.type !== 'engine') return;
    this.engine = msg.engine;
    this.engineReason = msg.reason;
    // `at` is the input sample's context time; it is heard one processing delay later.
    this.emitLatency(this.ctx ? msg.at + this.latency.processingSamples / this.ctx.sampleRate : undefined);
    this.onStateChange();
  }

  private post(msg: ToWorklet): void {
    this.sep?.port.postMessage(msg);
  }

  private emitLatency(ctxTime?: number): void {
    const info = this.latency;
    this.lastDeviceMs = info.deviceMs;
    const at = ctxTime === undefined || !this.ctx ? performance.now() : toPerformanceTime(this.ctx, ctxTime, info.deviceMs);
    for (const cb of this.listeners) cb(info, at);
  }

  private checkDeviceLatency(): void {
    if (Math.abs(this.deviceLatencyMs - this.lastDeviceMs) >= DEVICE_STEP_MS) this.emitLatency();
  }

  private connectIfReady(): void {
    const { ctx, direct, video } = this;
    if (!ctx || !direct) return;
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      this.listenForGesture();
      return;
    }
    this.stopListeningForGesture();
    if (!video || this.sources.has(video)) return;
    try {
      const source = ctx.createMediaElementSource(video);
      source.connect(direct);
      if (this.sep) source.connect(this.sep);
      this.sources.set(video, source);
      video.setAttribute(OWNER_ATTR, this.instanceId);
      this.lastError = undefined;
    } catch (e) {
      // An element feeds at most one MediaElementSource, for its whole life: someone else got there first.
      console.warn('[All Mixer!] audio error:', e);
      const owner = video.getAttribute(OWNER_ATTR);
      this.fail(owner && owner !== this.instanceId ? ERR_OTHER_COPY : ERR_OTHER_OWNER);
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
    if (typeof e !== 'string') console.warn('[All Mixer!] audio error:', e);
    this.onStateChange();
  }
}
