import type { AvProbe } from '../av-probe';
import { DelaySchedule, FrameQueue, PresentedClock, VIDEO_DELAY_BUDGET_BYTES, captureSize } from './schedule';

/**
 * Shows the <video> D ms late so it lines up with audio that the separation
 * graph delays by D ms (decision D1, method from SRI-14 / SRI-5 §5).
 *
 * requestVideoFrameCallback copies each decoded frame with createImageBitmap
 * (resized to a size that keeps the queue within a memory budget), and a requestAnimationFrame loop draws the
 * newest due frame onto an opaque canvas laid right after the <video>. The
 * <video> keeps playing underneath (Chrome stops decoding hidden videos), so
 * YouTube's controls, captions, ads UI and progress bar stay on top and work.
 *
 * - Seek: queued frames are stale, so they are dropped; the last picture stays
 *   until the first new frame is due (YouTube shows its spinner meanwhile).
 * - Pause: rVFC stops; the queue drains, matching the audio tail the graph
 *   plays out on pause.
 * - Delay change: jumps at the time the graph says it takes effect.
 * - Delay 0: the canvas is hidden and capture stops (no CPU cost).
 */

/** Give up after this many capture failures in a row (e.g. tainted video). */
const MAX_CAPTURE_ERRORS = 30;

const FPS_SAMPLES = 30;
const FPS_MIN_SAMPLES = 10;

/** Like a seek: frames from the old position / source must not be shown. */
const RESET_EVENTS = ['seeking', 'emptied', 'loadstart'] as const;
/** Budgets at or above this mean "unbounded" (JSON turns Infinity into null, so QA sends a big number). */
const LEGACY_BUDGET = 1e12;

const STAT_WINDOW = 300;

export interface VideoDelayStats {
  captureW: number;
  captureH: number;
  fps: number;
  queued: number;
  queueBytes: number;
  maxFrames: number;
  skipped: number;
  drawn: number;
  /** performance.now() - frame.due at draw time, last 300 draws. */
  errMs: { mean: number; p95: number };
  /** (video.currentTime - frame.mediaTime) * 1000 - delay at draw time. */
  avOffsetMs: { mean: number; p95: number };
}

function summarize(xs: number[]): { mean: number; p95: number } {
  if (!xs.length) return { mean: 0, p95: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] };
}

export type OverlayState = 'off' | 'waiting' | 'on' | 'failed';

export class DelayedVideo {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly schedule = new DelaySchedule(0);
  private readonly clock = new PresentedClock();
  private readonly queue = new FrameQueue<ImageBitmap>((b) => b.close());
  private readonly resizeObserver: ResizeObserver;
  private readonly styleObserver: MutationObserver;
  private shown: ImageBitmap | null = null;
  private vfc = 0;
  private raf = 0;
  private lastRaf = 0;
  private epoch = 0;
  private captureErrors = 0;
  private running = false;
  private destroyed = false;
  private failed = false;
  private budgetBytes = VIDEO_DELAY_BUDGET_BYTES;
  private capW = 2;
  private capH = 2;
  private fps = 60;
  private lastMediaTime = -1;
  private deltas: number[] = [];
  private drawn = 0;
  private errs: number[] = [];
  private offsets: number[] = [];
  private stopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onStateChange: (state: OverlayState) => void = () => {},
    private readonly probe: AvProbe | null = null,
  ) {
    const c = (this.canvas = document.createElement('canvas'));
    c.className = 'all-mixer-delayed-video';
    c.style.cssText = 'position:absolute;z-index:1;pointer-events:none;background:#000;display:none';
    this.ctx = c.getContext('2d', { alpha: false })!;
    this.ctx.imageSmoothingQuality = 'medium';
    this.resizeObserver = new ResizeObserver(() => this.layout());
    // YouTube moves the video with inline left/top on theater/fullscreen
    // changes; a ResizeObserver alone misses position-only changes.
    this.styleObserver = new MutationObserver(() => this.layout());
    for (const e of RESET_EVENTS) video.addEventListener(e, this.onSeeking);
    probe?.setOverlayInfo(() => ({ queue: this.queue.size, delay: this.schedule.target, shown: this.shown ? 1 : 0 }));
  }

  get state(): OverlayState {
    if (this.failed) return 'failed';
    if (!this.running) return 'off';
    return this.shown ? 'on' : 'waiting';
  }

  /** Media time (s) of the picture on screen now; null while the overlay is not showing one. */
  presentedTime(now = performance.now()): number | null {
    if (this.state !== 'on') return null;
    this.clock.pending(this.queue.nextMediaTime);
    return this.clock.at(now);
  }

  /** True while frames are queued for the overlay (it is still playing out or about to show a new position). */
  presentedBusy(): boolean {
    return this.state === 'on' && this.queue.size > 0;
  }

  get delayMs(): number {
    return this.schedule.target;
  }

  /**
   * Set the picture delay. `effectiveAtMs` (performance.now() time) is when
   * audio with the new latency starts coming out; default is now.
   */
  setDelay(delayMs: number, effectiveAtMs = performance.now()): void {
    if (this.destroyed) return;
    this.schedule.set(Math.max(0, delayMs), effectiveAtMs);
    this.updateCapture();
    clearTimeout(this.stopTimer);
    if (this.schedule.target > 0) return this.start();
    // Keep showing delayed frames until the audio drops its delay too, so
    // picture and sound jump forward together.
    const wait = effectiveAtMs - performance.now();
    if (wait > 0 && this.running) this.stopTimer = setTimeout(() => this.stop(), wait);
    else this.stop();
  }

  get stats(): VideoDelayStats {
    let queueBytes = 0;
    this.queue.forEach((b) => (queueBytes += b.width * b.height * 4));
    return {
      captureW: this.capW,
      captureH: this.capH,
      fps: this.fps,
      queued: this.queue.size,
      queueBytes,
      maxFrames: this.queue.capacity,
      skipped: this.queue.skipped,
      drawn: this.drawn,
      errMs: summarize(this.errs),
      avOffsetMs: summarize(this.offsets),
    };
  }

  /** QA only: override the memory budget (null restores the default). */
  setBudget(bytes: number | null): void {
    this.budgetBytes = bytes !== null && bytes > 0 ? bytes : VIDEO_DELAY_BUDGET_BYTES;
    this.updateCapture();
  }

  /** Recompute capture size and queue cap from display size, delay and fps. */
  private updateCapture(): void {
    const legacy = this.budgetBytes >= LEGACY_BUDGET;
    const displayW = Math.max(2, Math.round(this.video.clientWidth * devicePixelRatio));
    const displayH = Math.max(2, Math.round(this.video.clientHeight * devicePixelRatio));
    if (legacy) {
      // Old behaviour (display size, 120 frames) so QA can compare.
      this.capW = displayW;
      this.capH = displayH;
      this.queue.setCap(120);
      return;
    }
    const r = captureSize({
      displayW,
      displayH,
      videoW: this.video.videoWidth,
      videoH: this.video.videoHeight,
      delayMs: this.schedule.max,
      fps: this.fps,
      budgetBytes: this.budgetBytes,
    });
    this.capW = r.width;
    this.capH = r.height;
    this.queue.setCap(r.maxFrames);
  }

  private trackFps(mediaTime: number): void {
    const d = (mediaTime - this.lastMediaTime) / (this.video.playbackRate || 1);
    this.lastMediaTime = mediaTime;
    if (!(d > 0) || d > 1) return;
    this.deltas.push(d);
    if (this.deltas.length > FPS_SAMPLES) this.deltas.shift();
    if (this.deltas.length < FPS_MIN_SAMPLES) return;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const fps = Math.min(60, Math.max(15, 1 / sorted[sorted.length >> 1]));
    if (Math.abs(fps - this.fps) / this.fps > 0.1) {
      this.fps = fps;
      this.updateCapture();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    clearTimeout(this.stopTimer);
    this.stop();
    this.destroyed = true;
    for (const e of RESET_EVENTS) this.video.removeEventListener(e, this.onSeeking);
  }

  private start(): void {
    if (this.running || this.failed) return;
    this.running = true;
    this.captureErrors = 0;
    this.lastMediaTime = -1;
    this.deltas = [];
    this.video.insertAdjacentElement('afterend', this.canvas);
    this.resizeObserver.observe(this.video);
    this.styleObserver.observe(this.video, { attributes: true, attributeFilter: ['style', 'class'] });
    this.layout();
    this.vfc = this.video.requestVideoFrameCallback(this.onFrame);
    this.lastRaf = 0;
    this.raf = requestAnimationFrame(this.onRaf);
    this.onStateChange(this.state);
  }

  private stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epoch++;
    this.video.cancelVideoFrameCallback(this.vfc);
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.styleObserver.disconnect();
    this.queue.clear();
    this.shown?.close();
    this.shown = null;
    this.canvas.style.display = 'none';
    this.canvas.remove();
    this.clock.reset();
    this.probe?.overlayReset();
    this.onStateChange(this.state);
  }

  private fail(): void {
    console.warn('[All Mixer!] video delay overlay disabled: frame capture keeps failing');
    this.stop();
    this.failed = true;
    this.onStateChange(this.state);
  }

  private layout(): void {
    const v = this.video;
    const w = Math.max(2, Math.round(v.clientWidth * devicePixelRatio));
    const h = Math.max(2, Math.round(v.clientHeight * devicePixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      // Resizing clears the canvas; redraw the current picture scaled.
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.imageSmoothingQuality = 'medium'; // resizing resets context state
      if (this.shown) this.ctx.drawImage(this.shown, 0, 0, w, h);
    }
    this.updateCapture();
    Object.assign(this.canvas.style, {
      left: `${v.offsetLeft}px`,
      top: `${v.offsetTop}px`,
      width: `${v.clientWidth}px`,
      height: `${v.clientHeight}px`,
    });
  }

  private readonly onSeeking = (): void => {
    this.epoch++;
    this.queue.clear();
  };

  private readonly onFrame = (_now: number, md: VideoFrameCallbackMetadata): void => {
    if (!this.running) return;
    this.vfc = this.video.requestVideoFrameCallback(this.onFrame);
    this.trackFps(md.mediaTime);
    const delay = this.schedule.at(md.expectedDisplayTime);
    const due = md.expectedDisplayTime + delay;
    const epoch = this.epoch;
    const rvfcAt = performance.now();
    this.probe?.trace('rvfc', {
      rvfcNow: _now,
      mediaTime: md.mediaTime,
      expectedDisplayTime: md.expectedDisplayTime,
      due,
      delay,
      currentTime: this.video.currentTime,
      queue: this.queue.size,
    });
    createImageBitmap(this.video, { resizeWidth: this.capW, resizeHeight: this.capH, resizeQuality: 'low' }).then(
      (bmp) => {
        this.captureErrors = 0;
        if (epoch !== this.epoch || !this.running) return bmp.close();
        this.probe?.trace('bitmap', { mediaTime: md.mediaTime, due, captureMs: performance.now() - rvfcAt });
        this.queue.push({ due, mediaTime: md.mediaTime, delay, img: bmp }, performance.now());
      },
      () => {
        if (epoch === this.epoch && this.running && ++this.captureErrors >= MAX_CAPTURE_ERRORS) this.fail();
      },
    );
  };

  private readonly onRaf = (t: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.onRaf);
    const vsync = this.lastRaf ? Math.min(t - this.lastRaf, 50) : 16.7;
    this.lastRaf = t;
    const frame = this.queue.take(t, vsync);
    if (!frame) return;
    const { width, height } = this.canvas;
    this.ctx.drawImage(frame.img, 0, 0, width, height);
    this.drawn++;
    this.errs.push(performance.now() - frame.due);
    this.offsets.push((this.video.currentTime - frame.mediaTime) * 1000 - (frame.delay ?? 0));
    if (this.errs.length > STAT_WINDOW) {
      this.errs.shift();
      this.offsets.shift();
    }
    const first = !this.shown;
    this.probe?.trace('draw', {
      rafT: t,
      mediaTime: frame.mediaTime,
      due: frame.due,
      lateMs: performance.now() - frame.due,
      currentTime: this.video.currentTime,
      queue: this.queue.size,
    });
    this.probe?.overlayFrame(frame.mediaTime, t);
    this.shown?.close();
    this.shown = frame.img;
    this.clock.show(frame.mediaTime, t, this.video.playbackRate);
    const prevMax = this.schedule.max;
    this.schedule.prune(t);
    if (this.schedule.max < prevMax) this.updateCapture();
    if (first) {
      // Only cover the real video once there is a picture to show.
      this.canvas.style.display = '';
      this.onStateChange(this.state);
    }
  };
}
