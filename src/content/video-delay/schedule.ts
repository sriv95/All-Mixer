import type { Mode } from '../../shared/settings';

/**
 * Pure timing logic for the delayed-video overlay (D1). No DOM here, so it can
 * be unit tested; `DelayedVideo` does the capture and drawing.
 *
 * All times are `performance.now()` milliseconds.
 */

/** Below this total delay Default mode leaves the real <video> visible. */
export const DEFAULT_MODE_MIN_DELAY_MS = 45;

/**
 * How many ms the picture must lag, given the audio graph's total output delay
 * (algorithmic + `baseLatency + outputLatency`). 0 means "overlay off".
 *
 * Separate mode always matches the graph. Default mode only has device latency,
 * which people do not notice below ~45 ms, so it stays off there.
 */
export function overlayDelayMs(mode: Mode, totalLatencyMs: number): number {
  if (!Number.isFinite(totalLatencyMs) || totalLatencyMs <= 0) return 0;
  if (mode === 'default' && totalLatencyMs <= DEFAULT_MODE_MIN_DELAY_MS) return 0;
  return totalLatencyMs;
}

/**
 * Delay as a step function of time. A change takes effect at `atMs` (when the
 * graph starts emitting audio with the new latency), so frames meant to be
 * shown before that keep the old delay. Changes jump; they are not slewed
 * (SRI-14: a short freeze or skip is less noticeable than a speed change).
 */
export class DelaySchedule {
  private steps: { at: number; delay: number }[];

  constructor(initialMs = 0) {
    this.steps = [{ at: -Infinity, delay: initialMs }];
  }

  set(delayMs: number, atMs: number): void {
    // A newer change replaces any pending change scheduled at or after it.
    this.steps = this.steps.filter((s) => s.at < atMs);
    if (this.steps.length === 0) this.steps.push({ at: -Infinity, delay: delayMs });
    else this.steps.push({ at: atMs, delay: delayMs });
  }

  /** Delay that applies to a frame the <video> would show at time `t`. */
  at(t: number): number {
    let d = this.steps[0].delay;
    for (const s of this.steps) if (s.at <= t) d = s.delay;
    return d;
  }

  /** Latest scheduled delay (what the schedule settles to). */
  get target(): number {
    return this.steps[this.steps.length - 1].delay;
  }

  /** Largest delay among current steps (the old delay still applies until a pending step's time). */
  get max(): number {
    return Math.max(...this.steps.map((s) => s.delay));
  }

  /** Forget steps that no frame before `t` can need anymore. */
  prune(t: number): void {
    let i = 0;
    while (i + 1 < this.steps.length && this.steps[i + 1].at <= t) i++;
    if (i > 0) this.steps = [{ at: -Infinity, delay: this.steps[i].delay }, ...this.steps.slice(i + 1)];
  }
}

/** With an empty queue the clock may run this far past the last shown frame (one frame at 30 fps, plus jitter). */
export const MAX_EXTRAPOLATE_S = 0.05;

/** A queued frame further ahead than this is a seek, not the next frame of normal playback. */
const DISCONTINUITY_S = 1;

/**
 * Media time of the picture on screen, for things that must follow what the
 * user sees and hears (lyrics). Driven by the overlay: `show` when a frame is
 * drawn, `pending` with the oldest queued frame. Between frames it advances at
 * the playback rate, but never past the next queued frame, and by at most
 * MAX_EXTRAPOLATE_S when nothing is queued. So it freezes on pause or a stall,
 * and holds through a seek until the first new frame is drawn.
 */
export class PresentedClock {
  private frame: { mediaTime: number; shownAt: number; rate: number } | null = null;
  private next: number | null = null;

  show(mediaTime: number, shownAt: number, rate: number): void {
    this.frame = { mediaTime, shownAt, rate };
  }

  /** Media time of the oldest queued frame, or null when the queue is empty. */
  pending(nextMediaTime: number | null): void {
    this.next = nextMediaTime;
  }

  at(now: number): number | null {
    const f = this.frame;
    if (!f) return null;
    const t = f.mediaTime + (Math.max(0, now - f.shownAt) / 1000) * f.rate;
    const n = this.next;
    // A queued frame behind or far ahead of the shown one is a seek: treat the queue as empty until it is drawn.
    const limit = n !== null && n >= f.mediaTime && n - f.mediaTime <= DISCONTINUITY_S ? n : f.mediaTime + MAX_EXTRAPOLATE_S;
    return Math.min(t, limit);
  }

  reset(): void {
    this.frame = null;
    this.next = null;
  }
}

/** Memory budget for queued delay frames (RGBA, 4 bytes per pixel). */
export const VIDEO_DELAY_BUDGET_BYTES = 384 * 1024 * 1024;

export interface CaptureSizeInput {
  /** Display size in device pixels. */
  displayW: number;
  displayH: number;
  /** Native video size; 0 when unknown. */
  videoW: number;
  videoH: number;
  delayMs: number;
  fps: number;
  budgetBytes: number;
}

/**
 * Size to capture frames at and how many to keep, so that the delay queue fits
 * the memory budget. Keeps the aspect ratio of the display size.
 */
export function captureSize(i: CaptureSizeInput): { width: number; height: number; maxFrames: number } {
  let w = Math.max(2, i.displayW);
  let h = Math.max(2, i.displayH);
  if (i.videoW > 0 && i.videoH > 0 && w * h > i.videoW * i.videoH) {
    const k = Math.sqrt((i.videoW * i.videoH) / (w * h));
    w *= k;
    h *= k;
  }
  // Margin of 8 for in-flight captures and jitter.
  const frames = Math.ceil((i.delayMs / 1000) * i.fps) + 8;
  const maxPx = i.budgetBytes / (4 * frames);
  if (w * h > maxPx) {
    const k = Math.sqrt(maxPx / (w * h));
    w *= k;
    h *= k;
  }
  // Floor, so rounding never pushes the total over the budget.
  w = Math.max(2, Math.floor(w));
  h = Math.max(2, Math.floor(h));
  const maxFrames = Math.min(frames * 2, Math.max(frames, Math.floor(i.budgetBytes / (4 * w * h))));
  return { width: w, height: h, maxFrames };
}

export interface QueuedFrame<T> {
  /** When this frame should reach the screen. */
  due: number;
  mediaTime: number;
  /** Schedule delay that applied when the frame was captured (for stats). */
  delay?: number;
  img: T;
}

/**
 * Captured frames waiting for their due time, oldest first. `release` frees a
 * frame's GPU memory (ImageBitmap.close) once it is dropped or replaced.
 */
/** A queued frame this far past due means rAF is not running (hidden tab). */
const OVERDUE_MS = 100;

export class FrameQueue<T> {
  private frames: QueuedFrame<T>[] = [];
  skipped = 0;

  constructor(
    private readonly release: (img: T) => void,
    /** Safety cap (set at runtime from `captureSize`). More means rAF stopped (hidden tab). */
    private cap = 120,
  ) {
    this.hardCap = cap;
  }

  /** Frames allowed while some queued frame is not yet due (lets the cap shrink without a freeze). */
  private hardCap: number;

  /** Never releases frames: lowering the cap must not drop frames that are not yet due. */
  setCap(n: number): void {
    this.cap = Math.max(1, Math.floor(n));
    // Keep the old bound until the queue drains below the new cap (see push).
    this.hardCap = Math.max(this.cap, this.hardCap);
  }

  forEach(fn: (img: T) => void): void {
    for (const f of this.frames) fn(f.img);
  }

  get capacity(): number {
    return this.cap;
  }

  get size(): number {
    return this.frames.length;
  }

  /** Media time of the oldest queued frame, or null when empty. */
  get nextMediaTime(): number | null {
    return this.frames.length ? this.frames[0].mediaTime : null;
  }

  push(frame: QueuedFrame<T>, now: number): void {
    // Captures resolve in order in practice; insert sorted to be safe.
    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1].due > frame.due) i--;
    this.frames.splice(i, 0, frame);
    // Over the cap: trim only overdue frames (rAF stopped), or anything past the hard cap.
    while (this.frames.length > this.cap && (this.frames[0].due < now - OVERDUE_MS || this.frames.length > this.hardCap)) {
      this.release(this.frames.shift()!.img);
    }
    if (this.frames.length <= this.cap) this.hardCap = this.cap;
  }

  /**
   * Remove and return the newest frame due by the middle of the vsync that
   * starts at `now`. Older due frames are released and counted as skipped.
   * Returns null when nothing is due yet (keep showing the last picture).
   */
  take(now: number, vsyncMs: number): QueuedFrame<T> | null {
    const limit = now + vsyncMs / 2;
    let pick = -1;
    while (pick + 1 < this.frames.length && this.frames[pick + 1].due <= limit) pick++;
    if (pick < 0) return null;
    for (let i = 0; i < pick; i++) this.release(this.frames[i].img);
    this.skipped += pick;
    const frame = this.frames[pick];
    this.frames = this.frames.slice(pick + 1);
    return frame;
  }

  clear(): void {
    for (const f of this.frames) this.release(f.img);
    this.frames = [];
  }
}
