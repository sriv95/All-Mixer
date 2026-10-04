import { DelaySchedule, FrameQueue } from './schedule';

/**
 * Shows the <video> D ms late so it lines up with audio that the separation
 * graph delays by D ms (decision D1, method from SRI-14 / SRI-5 §5).
 *
 * requestVideoFrameCallback copies each decoded frame with createImageBitmap
 * (resized to the display size), and a requestAnimationFrame loop draws the
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

export type OverlayState = 'off' | 'waiting' | 'on' | 'failed';

export class DelayedVideo {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly schedule = new DelaySchedule(0);
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
  private stopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onStateChange: (state: OverlayState) => void = () => {},
  ) {
    const c = (this.canvas = document.createElement('canvas'));
    c.className = 'all-mixer-delayed-video';
    c.style.cssText = 'position:absolute;z-index:1;pointer-events:none;background:#000;display:none';
    this.ctx = c.getContext('2d', { alpha: false })!;
    this.resizeObserver = new ResizeObserver(() => this.layout());
    // YouTube moves the video with inline left/top on theater/fullscreen
    // changes; a ResizeObserver alone misses position-only changes.
    this.styleObserver = new MutationObserver(() => this.layout());
    video.addEventListener('seeking', this.onSeeking);
  }

  get state(): OverlayState {
    if (this.failed) return 'failed';
    if (!this.running) return 'off';
    return this.shown ? 'on' : 'waiting';
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
    clearTimeout(this.stopTimer);
    if (this.schedule.target > 0) return this.start();
    // Keep showing delayed frames until the audio drops its delay too, so
    // picture and sound jump forward together.
    const wait = effectiveAtMs - performance.now();
    if (wait > 0 && this.running) this.stopTimer = setTimeout(() => this.stop(), wait);
    else this.stop();
  }

  destroy(): void {
    if (this.destroyed) return;
    clearTimeout(this.stopTimer);
    this.stop();
    this.destroyed = true;
    this.video.removeEventListener('seeking', this.onSeeking);
  }

  private start(): void {
    if (this.running || this.failed) return;
    this.running = true;
    this.captureErrors = 0;
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
      if (this.shown) this.ctx.drawImage(this.shown, 0, 0, w, h);
    }
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
    const due = md.expectedDisplayTime + this.schedule.at(md.expectedDisplayTime);
    const epoch = this.epoch;
    const { width, height } = this.canvas;
    createImageBitmap(this.video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' }).then(
      (bmp) => {
        this.captureErrors = 0;
        if (epoch !== this.epoch || !this.running) return bmp.close();
        this.queue.push({ due, mediaTime: md.mediaTime, img: bmp });
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
    const first = !this.shown;
    this.shown?.close();
    this.shown = frame.img;
    this.schedule.prune(t);
    if (first) {
      // Only cover the real video once there is a picture to show.
      this.canvas.style.display = '';
      this.onStateChange(this.state);
    }
  };
}
