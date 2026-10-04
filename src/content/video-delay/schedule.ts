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

  /** Forget steps that no frame before `t` can need anymore. */
  prune(t: number): void {
    let i = 0;
    while (i + 1 < this.steps.length && this.steps[i + 1].at <= t) i++;
    if (i > 0) this.steps = [{ at: -Infinity, delay: this.steps[i].delay }, ...this.steps.slice(i + 1)];
  }
}

export interface QueuedFrame<T> {
  /** When this frame should reach the screen. */
  due: number;
  mediaTime: number;
  img: T;
}

/**
 * Captured frames waiting for their due time, oldest first. `release` frees a
 * frame's GPU memory (ImageBitmap.close) once it is dropped or replaced.
 */
export class FrameQueue<T> {
  private frames: QueuedFrame<T>[] = [];
  skipped = 0;

  constructor(
    private readonly release: (img: T) => void,
    /** Safety cap: 2 s at 60 fps. More means rAF stopped (hidden tab). */
    private readonly cap = 120,
  ) {}

  get size(): number {
    return this.frames.length;
  }

  push(frame: QueuedFrame<T>): void {
    // Captures resolve in order in practice; insert sorted to be safe.
    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1].due > frame.due) i--;
    this.frames.splice(i, 0, frame);
    while (this.frames.length > this.cap) this.release(this.frames.shift()!.img);
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
