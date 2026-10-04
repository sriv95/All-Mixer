/**
 * Audio delay reported by the graph, so the video overlay (D1) can match it.
 * Read it at run time; it changes with the engine, the sample rate and the
 * output device.
 */

/** bypass = no separation (Default mode or separation off). */
export type EngineKind = 'bypass' | 'dsp' | 'ml';
/** Why this engine runs: picked automatically, fell back after missed deadlines, or chosen in settings. */
export type EngineReason = 'auto' | 'deadline-miss' | 'user';

export interface LatencyInfo {
  engine: EngineKind;
  reason: EngineReason;
  sampleRate: number;
  /** Delay the separator adds, in samples at `sampleRate`. 0 for bypass. */
  processingSamples: number;
  processingMs: number;
  /** `(baseLatency + outputLatency) · 1000`; 0 while the graph is not running. */
  deviceMs: number;
  /** processingMs + deviceMs: how late the picture must be to match the sound. */
  videoDelayMs: number;
}

/**
 * Called when the delay changes. `effectiveAt` (performance.now() ms) is when
 * the first audio with the new delay reaches the speakers.
 */
export type LatencyListener = (info: LatencyInfo, effectiveAt: number) => void;

/** performance.now() time at which audio scheduled at context time `t` is heard. */
export function toPerformanceTime(ctx: BaseAudioContext, t: number, deviceMs: number): number {
  const ts = 'getOutputTimestamp' in ctx ? (ctx as AudioContext).getOutputTimestamp() : undefined;
  if (ts?.performanceTime && ts.contextTime !== undefined) {
    return ts.performanceTime + (t - ts.contextTime) * 1000;
  }
  return performance.now() + (t - ctx.currentTime) * 1000 + deviceMs;
}
