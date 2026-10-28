const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** Half width of the sinc kernel, in input samples at the lower of the two rates. */
const HALF = 32;
const MAX_PHASES = 1024;

/**
 * Streaming stereo resampler: windowed sinc (Blackman), the cutoff at 95 % of the lower Nyquist. The output of a stream cut in
 * any pieces equals the output of the whole stream. The first `HALF` output samples fade in from a zero history.
 */
export class Resampler {
  private readonly l: number;
  private readonly m: number;
  private readonly phases: number;
  private readonly taps: number;
  private readonly half: number;
  private readonly table: Float64Array;
  /** Input kept between calls (per channel), and the absolute index of its first sample. */
  private histL = new Float32Array(0);
  private histR = new Float32Array(0);
  private histStart = 0;
  /** Index of the next output sample. */
  private n = 0;

  constructor(readonly inRate: number, readonly outRate: number) {
    const g = gcd(inRate, outRate);
    this.l = outRate / g;
    this.m = inRate / g;
    this.phases = Math.min(this.l, MAX_PHASES);
    const fc = Math.min(1, outRate / inRate) * 0.95; // a little below Nyquist: the transition band of the window stays below it
    this.half = Math.ceil(HALF / fc);
    this.taps = 2 * this.half;
    this.table = new Float64Array(this.phases * this.taps);
    for (let p = 0; p < this.phases; p++) {
      const frac = p / this.phases;
      let sum = 0;
      for (let t = 0; t < this.taps; t++) {
        const x = t - this.half + 1 - frac; // distance of tap t from the output position, in input samples
        const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / this.half) + 0.08 * Math.cos((2 * Math.PI * x) / this.half);
        const s = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
        const v = fc * s * w;
        this.table[p * this.taps + t] = v;
        sum += v;
      }
      for (let t = 0; t < this.taps; t++) this.table[p * this.taps + t] /= sum; // unity gain at DC for every phase
    }
  }

  /** Feed `l`/`r` (the same length); returns the output samples that are complete now. */
  process(l: Float32Array, r: Float32Array): [Float32Array, Float32Array] {
    if (this.inRate === this.outRate) return [l, r];
    const bl = concat(this.histL, l), br = concat(this.histR, r);
    const end = this.histStart + bl.length; // absolute index after the last input sample
    const outL: number[] = [], outR: number[] = [];
    for (;; this.n++) {
      const pos = this.n * this.m; // output n sits at input pos / l
      const i0 = Math.floor(pos / this.l);
      if (i0 + this.half >= end) break; // the kernel needs input that has not come yet
      const phase = Math.floor(((pos % this.l) / this.l) * this.phases);
      const base = phase * this.taps;
      const first = i0 - this.half + 1 - this.histStart; // index in the buffer of tap 0
      let sl = 0, sr = 0;
      for (let t = 0; t < this.taps; t++) {
        const k = first + t;
        if (k < 0) continue; // before the start of the stream: silence
        const w = this.table[base + t];
        sl += w * bl[k];
        sr += w * br[k];
      }
      outL.push(sl);
      outR.push(sr);
    }
    // Keep what the next output sample still needs.
    const need = Math.max(0, Math.floor((this.n * this.m) / this.l) - this.half + 1);
    const drop = Math.min(bl.length, Math.max(0, need - this.histStart));
    this.histL = bl.slice(drop);
    this.histR = br.slice(drop);
    this.histStart += drop;
    return [Float32Array.from(outL), Float32Array.from(outR)];
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (!a.length) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
