import type { AvProbeStatus, AvTransition } from '../shared/messages';
import type { LatencyInfo } from './audio/latency';
import { toPerformanceTime } from './audio/latency';
import { pairTransition, windowFor, WINDOW_MS, type PairEdge } from './video-delay/transitions';
import { ActivityEdges, AudioEdgeDetector, type Edge } from './video-delay/edge-detect';

/**
 * Debug-only A/V sync probe (SRI-95). Measures when picture and sound start
 * and stop so QA can read the offset at pause / play / seek instead of judging
 * by eye. Off unless localStorage['allMixer.avProbe'] === '1' (read at start
 * and on each `play`); while off it creates no node, listener loop or timer.
 */

const FLAG = 'allMixer.avProbe';
const PREFIX = '[All Mixer! avProbe]';
const MEDIA_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ratechange', 'emptied'] as const;
const FFT_SIZE = 2048;
const MAX_TRANSITIONS = 20;
const MAX_EDGES = 80;
const TRACE_FRAMES = 10;

const readFlag = (): boolean => {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
};

export class AvProbe {
  private enabled = false;
  private video: HTMLVideoElement | null = null;
  private audio: { ctx: AudioContext; source: AudioNode; latency: () => LatencyInfo } | null = null;
  private analyser: AnalyserNode | null = null;
  private detector: AudioEdgeDetector | null = null;
  private buf = new Float32Array(FFT_SIZE);
  private readonly videoEdges = new ActivityEdges();
  private readonly overlayEdges = new ActivityEdges();
  private readonly usedEdges = new Set<PairEdge>();
  private lastVideoMedia = NaN;
  private lastOverlayMedia = NaN;
  private vfc = 0;
  private raf = 0;
  private readonly st: AvProbeStatus = { events: {} };
  private readonly edgeLog: PairEdge[] = [];
  private readonly pending: { kind: 'pause' | 'play'; at: number; delayMs: number; latencyMs: number }[] = [];
  private readonly done: AvTransition[] = [];
  private awaitingPlay = false;
  private readonly traceCounts: Record<string, number> = {};
  private overlayInfo: (() => Record<string, number>) | null = null;

  constructor(private readonly readEnabled: () => boolean = readFlag) {
    this.refresh();
  }

  get on(): boolean {
    return this.enabled;
  }

  /** Latest edges and derived offsets. */
  get status(): AvProbeStatus {
    const { audioOn, audioOff, videoOn, videoOff, overlayOn, overlayOff } = this.st;
    const playPic = overlayOn ?? videoOn;
    const pausePic = overlayOff ?? videoOff;
    this.flush(performance.now());
    return {
      ...this.st,
      transitions: [...this.done],
      probeOn: this.enabled,
      audioAttached: this.audio !== null,
      ctxState: this.audio?.ctx.state,
      events: { ...this.st.events },
      playOffsetMs: audioOn && playPic !== undefined ? audioOn.audibleAt - playPic : undefined,
      pauseOffsetMs: audioOff && pausePic !== undefined ? audioOff.audibleAt - pausePic : undefined,
      pipelineMs: audioOn && videoOn !== undefined ? audioOn.inputAt - videoOn : undefined,
    };
  }

  attachVideo(video: HTMLVideoElement): void {
    this.detachVideo();
    this.video = video;
    for (const e of MEDIA_EVENTS) video.addEventListener(e, this.onMedia);
    if (this.enabled) this.startVideo();
  }

  /** The MediaElementSource the chain made, tapped by an analyser while the probe is on. */
  attachAudio(ctx: AudioContext, source: AudioNode, latency: () => LatencyInfo): void {
    this.audio = { ctx, source, latency };
    if (this.enabled) this.startAudio();
  }

  /** Overlay state (queue size etc.) for the resume trace. */
  setOverlayInfo(fn: (() => Record<string, number>) | null): void {
    this.overlayInfo = fn;
  }

  /**
   * SRI-131 resume frame trace: logs the first ~10 `kind` entries after each
   * pause / play event. Returns true if it logged (caller can skip work otherwise).
   */
  trace(kind: string, data: Record<string, unknown>): boolean {
    if (!this.enabled || (this.traceCounts[kind] ?? 0) >= TRACE_FRAMES) return false;
    this.traceCounts[kind] = (this.traceCounts[kind] ?? 0) + 1;
    console.log(PREFIX, 'trace', JSON.stringify({ kind, now: performance.now(), n: this.traceCounts[kind], ...data }));
    return true;
  }

  /** The overlay drew a frame (rAF time `t`). */
  overlayFrame(mediaTime: number, t: number): void {
    if (!this.enabled || mediaTime === this.lastOverlayMedia) return;
    this.lastOverlayMedia = mediaTime;
    const edges = this.overlayEdges.event(t);
    this.trace('probeOverlayFrame', { mediaTime, rafT: t, edge: edges.map((e) => e.kind + '@' + e.at) });
    this.record(edges, 'overlay');
  }

  /** The overlay stopped: picture offsets fall back to the real video. */
  overlayReset(): void {
    this.overlayEdges.reset();
    this.lastOverlayMedia = NaN;
    this.st.overlayOn = this.st.overlayOff = undefined;
  }

  private refresh(): void {
    const on = this.readEnabled();
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.startVideo();
      this.startAudio();
    } else {
      this.stopAll();
    }
  }

  private readonly onMedia = (e: Event): void => {
    if (e.type === 'play') this.refresh();
    if (!this.enabled) return;
    const at = performance.now();
    this.st.events[e.type] = at;
    console.log(PREFIX, e.type, JSON.stringify({ at }));
    this.flush(at);
    if (e.type === 'play' || e.type === 'pause') for (const k of Object.keys(this.traceCounts)) this.traceCounts[k] = 0;
    if (e.type === 'play' || e.type === 'playing' || e.type === 'pause') {
      console.log(
        PREFIX,
        'trace',
        JSON.stringify({ kind: e.type, now: at, currentTime: this.video?.currentTime, ...this.overlayInfo?.() }),
      );
    }
    if (e.type === 'pause') {
      this.pending.push({ kind: 'pause', at, ...this.windowExtra() });
      this.awaitingPlay = true;
    } else if (e.type === 'seeking') {
      this.awaitingPlay = true;
    } else if ((e.type === 'play' || e.type === 'playing') && this.awaitingPlay) {
      this.pending.push({ kind: 'play', at, ...this.windowExtra() });
      this.awaitingPlay = false;
    }
  };

  private startVideo(): void {
    if (!this.video || this.vfc) return;
    const cb = (_now: number, md: VideoFrameCallbackMetadata): void => {
      this.vfc = this.video?.requestVideoFrameCallback(cb) ?? 0;
      if (md.mediaTime === this.lastVideoMedia) return;
      this.lastVideoMedia = md.mediaTime;
      const edges = this.videoEdges.event(md.expectedDisplayTime);
      this.trace('probeVideoFrame', { mediaTime: md.mediaTime, expectedDisplayTime: md.expectedDisplayTime, edge: edges.map((e) => e.kind + '@' + e.at) });
      this.record(edges, 'video');
    };
    this.vfc = this.video.requestVideoFrameCallback(cb);
    this.loop();
  }

  private startAudio(): void {
    if (!this.audio || this.analyser) return;
    const { ctx, source } = this.audio;
    // Tap only: the analyser is never connected to the output.
    this.analyser = new AnalyserNode(ctx, { fftSize: FFT_SIZE });
    this.detector = new AudioEdgeDetector(ctx.sampleRate);
    source.connect(this.analyser);
    this.loop();
  }

  private stopAll(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.vfc) this.video?.cancelVideoFrameCallback(this.vfc);
    this.vfc = 0;
    if (this.analyser) this.audio?.source.disconnect(this.analyser);
    this.analyser = null;
    this.detector = null;
    this.videoEdges.reset();
    this.overlayEdges.reset();
  }

  private detachVideo(): void {
    if (!this.video) return;
    for (const e of MEDIA_EVENTS) this.video.removeEventListener(e, this.onMedia);
    if (this.vfc) this.video.cancelVideoFrameCallback(this.vfc);
    this.vfc = 0;
  }

  private loop(): void {
    if (this.raf) return;
    const tick = (t: number): void => {
      this.raf = requestAnimationFrame(tick);
      this.record(this.videoEdges.poll(t), 'video');
      this.record(this.overlayEdges.poll(t), 'overlay');
      this.readAudio();
      this.flush(performance.now());
    };
    this.raf = requestAnimationFrame(tick);
  }

  private readAudio(): void {
    const { analyser, detector, audio } = this;
    if (!analyser || !detector || !audio) return;
    analyser.getFloatTimeDomainData(this.buf);
    const { ctx } = audio;
    const nowPerf = performance.now();
    const nowCtx = ctx.currentTime;
    for (const edge of detector.feed(this.buf, nowCtx)) {
      const t = edge.at / 1000; // context seconds
      // toPerformanceTime already yields the speaker time (device latency included), so inputAt must not use it.
      const inputAt = nowPerf + (t - nowCtx) * 1000;
      const lat = audio.latency();
      const v = { inputAt, audibleAt: toPerformanceTime(ctx, t, lat.deviceMs) + lat.processingMs };
      this.logEdge({ source: 'audio', kind: edge.kind, t: v.audibleAt, inputAt: v.inputAt });
      if (edge.kind === 'on') this.st.audioOn = v;
      else this.st.audioOff = v;
      console.log(PREFIX, edge.kind === 'on' ? 'audioOn' : 'audioOff', JSON.stringify({ ...v, engine: lat.engine }));
    }
  }

  private record(edges: Edge[], what: 'video' | 'overlay'): void {
    for (const e of edges) {
      const key = `${what}${e.kind === 'on' ? 'On' : 'Off'}` as 'videoOn' | 'videoOff' | 'overlayOn' | 'overlayOff';
      this.st[key] = e.at;
      this.logEdge({ source: what, kind: e.kind, t: e.at });
      console.log(PREFIX, key, JSON.stringify({ at: e.at }));
    }
  }

  private logEdge(e: PairEdge): void {
    this.edgeLog.push(e);
    if (this.edgeLog.length > MAX_EDGES) this.usedEdges.delete(this.edgeLog.shift()!);
  }

  /** Overlay delay (schedule target) and separator latency at the event, to widen the pairing window. */
  private windowExtra(): { delayMs: number; latencyMs: number } {
    const delayMs = this.overlayInfo?.().delay ?? 0;
    const latencyMs = delayMs > 0 ? (this.audio?.latency().videoDelayMs ?? 0) : 0;
    return { delayMs, latencyMs };
  }

  /** Finish every transition whose window has closed. */
  private flush(now: number): void {
    while (this.pending.length && windowFor(this.pending[0].kind, this.pending[0].at, this.pending[0].delayMs, this.pending[0].latencyMs)[1] + WINDOW_MS / 10 <= now) {
      const p = this.pending.shift()!;
      const tr = pairTransition(p.kind, p.at, this.edgeLog, p.delayMs, p.latencyMs, this.usedEdges);
      this.done.push(tr);
      if (this.done.length > MAX_TRANSITIONS) this.done.shift();
      console.log(PREFIX, 'transition', JSON.stringify(tr));
    }
  }
}
