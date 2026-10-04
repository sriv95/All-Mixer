/**
 * Output-safety stage for the 0–600 % boost: a fast compressor used as a
 * limiter, a trim that cancels the compressor's automatic makeup gain, and a
 * soft clipper that keeps peaks below full scale.
 *
 * Owner of the final DSP tuning: Marquess (audio team). This is the baseline
 * that ships with the extension skeleton; the in/out node interface is stable.
 */

export const LIMITER = {
  thresholdDb: -1.5,
  kneeDb: 0,
  ratio: 20,
  attackSec: 0.002,
  releaseSec: 0.15,
  /** Soft clipper is linear up to this level, then bends smoothly toward the ceiling. */
  clipKnee: 0.8,
  /** Absolute output ceiling (≈ -0.2 dBFS). */
  ceiling: 0.98,
} as const;

/**
 * Chrome's DynamicsCompressorNode adds automatic makeup gain (Web Audio spec:
 * makeup = (1 / curve(1.0)) ^ 0.6). Returns the linear trim that removes it,
 * so 100 % sounds like the untouched page.
 */
export function makeupTrim(thresholdDb: number, ratio: number): number {
  // Compression curve at 0 dBFS input (knee 0): threshold + (0 - threshold) / ratio.
  const outDb = thresholdDb + -thresholdDb / ratio;
  const makeupDb = -outDb * 0.6;
  return 10 ** (-makeupDb / 20);
}

/** Transfer function of the soft clipper. Odd, monotonic, |y| <= ceiling < 1. */
export function softClip(x: number, knee: number = LIMITER.clipKnee, ceiling: number = LIMITER.ceiling): number {
  const a = Math.abs(x);
  if (a <= knee) return x;
  const headroom = ceiling - knee;
  const y = knee + headroom * Math.tanh((a - knee) / headroom);
  return Math.sign(x) * y;
}

export function softClipCurve(size = 4096, knee: number = LIMITER.clipKnee): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  // WaveShaper maps input [-1, 1] across the curve; inputs beyond ±1 use the end values,
  // which the compressor in front keeps rare.
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = softClip(x, knee);
  }
  return curve;
}

export interface Stage {
  input: AudioNode;
  output: AudioNode;
}

export function createLimiter(ctx: BaseAudioContext): Stage {
  const comp = new DynamicsCompressorNode(ctx, {
    threshold: LIMITER.thresholdDb,
    knee: LIMITER.kneeDb,
    ratio: LIMITER.ratio,
    attack: LIMITER.attackSec,
    release: LIMITER.releaseSec,
  });
  const trim = new GainNode(ctx, { gain: makeupTrim(LIMITER.thresholdDb, LIMITER.ratio) });
  const clip = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: '4x' });
  comp.connect(trim).connect(clip);
  return { input: comp, output: clip };
}
