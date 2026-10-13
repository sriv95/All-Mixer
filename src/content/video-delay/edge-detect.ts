/**
 * On/off edge detection for the A/V sync probe (SRI-95, debug only).
 * Pure: times are plain numbers in whatever unit the caller uses (ms here).
 */

export interface Edge {
  kind: 'on' | 'off';
  /** Time of the first (on) or last (off) activity. */
  at: number;
}

/** Quiet this long (ms) splits activity into separate runs. */
const GAP_MS = 100;

/**
 * Turns a stream of "something happened at t" events into on / off edges.
 * `on` is the first event after at least `gap` of silence; `off` is the last
 * event, reported once `gap` of silence has been seen (via `poll` or the next
 * event). Gaps shorter than `gap` produce no edge.
 */
export class ActivityEdges {
  private active = false;
  private last = -Infinity;

  constructor(private readonly gap = GAP_MS) {}

  /** Activity at time `t` (non-decreasing). */
  event(t: number): Edge[] {
    const out = this.poll(t);
    if (!this.active) {
      this.active = true;
      out.push({ kind: 'on', at: t });
    }
    this.last = t;
    return out;
  }

  /** Time has reached `now` with no activity since the last event. */
  poll(now: number): Edge[] {
    if (!this.active || now - this.last < this.gap) return [];
    this.active = false;
    return [{ kind: 'off', at: this.last }];
  }

  reset(): void {
    this.active = false;
    this.last = -Infinity;
  }
}

/** -50 dBFS. */
export const AUDIO_THRESHOLD = 0.00316;

/**
 * Edges in a stream of overlapping time-domain buffers (AnalyserNode style).
 * Each buffer ends at `endTime` (s) and the newest sample is the last one.
 * Edge times come back in ms on the same clock as `endTime`.
 */
export class AudioEdgeDetector {
  private readonly edges = new ActivityEdges();
  private lastEnd = -Infinity;

  constructor(private readonly sampleRate: number) {}

  feed(samples: Float32Array, endTime: number): Edge[] {
    const n = samples.length;
    const fresh = Math.min(n, Math.round((endTime - this.lastEnd) * this.sampleRate));
    this.lastEnd = Math.max(this.lastEnd, endTime);
    const out: Edge[] = [];
    for (let i = n - Math.max(0, fresh); i < n; i++) {
      const t = (endTime - (n - 1 - i) / this.sampleRate) * 1000;
      out.push(...(Math.abs(samples[i]) > AUDIO_THRESHOLD ? this.edges.event(t) : this.edges.poll(t)));
    }
    return out;
  }
}
