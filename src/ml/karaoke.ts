// Karaoke combine (SRI-116 pick H3 p = 2, g = 0.8, spike/ml/hybrid_stream.py rows_for):
//   instrumental = (x − V_mdx) · (1 − g · m²)   per STFT bin, bins ≥ 150 Hz and < 1024, m = Spleeter vocal mask
// in the n_fft 4096 / hop 1024 STFT of x − V_mdx, then iSTFT / Σw² (steady state 1.5; the first 2048 samples
// use the real envelope, as scipy does). The MDX vocal stays the A cappella stem; this only changes the
// instrumental, which the worklet forms as x − Vk, so `emit` returns Vk = x − instrumental.
//
// Frame t covers input [1024t − 1024, 1024t + 3072) (the grid of SpleeterStream; python's STFT frame t + 1).
// Frame t is added once its 4096 samples of x − V exist; sample n is complete when every frame that covers it
// has been added, so the output lags the MDX vocal by at most one frame: KARAOKE_TAIL = 4096.
//
// Everything is in absolute stream positions in power-of-two rings. No allocation after construction.
import { FFT } from './fft.js';
import { BINS, HOP, N_FFT } from './stream';

/** Margin g (runtime constant, tune after listening). */
export const KARAOKE_G = 0.8;
export const KARAOKE_GATE_HZ = 150;
const SAMPLE_RATE = 44100;
/** First bin with frequency ≥ KARAOKE_GATE_HZ. */
export const KARAOKE_GATE_BIN = Math.ceil((KARAOKE_GATE_HZ * N_FFT) / SAMPLE_RATE);
const RING = 131072; // > 2 · 34304 + 4096, power of two
const MASK = RING - 1;
const MRING = 128; // mask frames kept; the producer is at most ~40 frames ahead of the consumer
const MMASK = MRING - 1;

export class KaraokeCombiner {
  private readonly fft = new FFT(N_FFT);
  private readonly win = new Float64Array(N_FFT);
  private readonly re = new Float64Array(N_FFT);
  private readonly im = new Float64Array(N_FFT);
  /** Input and MDX vocal, [L: RING][R: RING], by absolute position. */
  private readonly xr = new Float32Array(2 * RING);
  private readonly vr = new Float32Array(2 * RING);
  /** iSTFT overlap-add of the instrumental and of Σw². */
  private readonly acc = new Float32Array(2 * RING);
  private readonly env = new Float32Array(RING);
  /** Spleeter vocal masks, [frame & MMASK][2][BINS]. */
  private readonly masks = new Float32Array(MRING * 2 * BINS);
  /** Next frame to add. Frame −1 (start −2048) is the first one python has. */
  private next = -1;
  /** Newest mask frame stored. */
  private maskTo = -1;
  /** Samples below this are complete (frames covering them are all added). */
  private done = 0;

  constructor(readonly g: number = KARAOKE_G) {
    for (let i = 0; i < N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  }

  reset(): void {
    this.xr.fill(0);
    this.vr.fill(0);
    this.acc.fill(0);
    this.env.fill(0);
    this.masks.fill(0);
    this.next = -1;
    this.maskTo = -1;
    this.done = 0;
  }

  /** Newest Spleeter mask frame stored (−1: none). */
  get maskFrame(): number {
    return this.maskTo;
  }

  /** Store input samples [pos, pos + n) (n ≤ RING). */
  writeInput(pos: number, l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const j = (pos + i) & MASK;
      this.xr[j] = l[i];
      this.xr[RING + j] = r[i];
    }
  }

  /** Store MDX vocal samples [pos, pos + n); samples before the stream start (pos + i < 0) are skipped. */
  writeVocal(pos: number, l: Float32Array, r: Float32Array, n: number): void {
    for (let i = Math.max(0, -pos); i < n; i++) {
      const j = (pos + i) & MASK;
      this.vr[j] = l[i];
      this.vr[RING + j] = r[i];
    }
  }

  /** Store the four mask frames t0 … t0 + 3 from SpleeterStream.masks (layout dst[(f · 2 + ch) · BINS + k]). */
  pushMasks(t0: number, m: Float32Array): void {
    for (let f = 0; f < 4; f++) {
      const t = t0 + f;
      if (t < 0) continue; // before the stream: no mask (python's frame −1 has none either)
      this.masks.set(m.subarray(f * 2 * BINS, (f + 1) * 2 * BINS), (t & MMASK) * 2 * BINS);
      if (t > this.maskTo) this.maskTo = t;
    }
  }

  /** Add every frame whose 4096 samples end at or before `limit` and whose mask is stored. */
  advance(limit: number): void {
    while (HOP * this.next - HOP + N_FFT <= limit && this.next <= this.maskTo) this.frame(this.next++);
  }

  /** Frame index the next `advance` needs a mask for, given the samples available up to `limit`. */
  neededMask(limit: number): number {
    return Math.floor((limit - N_FFT + HOP) / HOP);
  }

  /** Vk = x − instrumental for [pos, pos + n); the samples must be complete (`pos + n ≤ completeTo`). */
  emit(pos: number, n: number, outL: Float32Array, outR: Float32Array): void {
    const { xr, acc, env } = this;
    for (let i = 0; i < n; i++) {
      const j = (pos + i) & MASK;
      const e = env[j] > 1e-10 ? 1 / env[j] : 1;
      outL[i] = xr[j] - acc[j] * e;
      outR[i] = xr[RING + j] - acc[RING + j] * e;
    }
  }

  /** The MDX vocal for [pos, pos + n) (A cappella stem). */
  emitVocal(pos: number, n: number, outL: Float32Array, outR: Float32Array): void {
    for (let i = 0; i < n; i++) {
      const j = (pos + i) & MASK;
      outL[i] = this.vr[j];
      outR[i] = this.vr[RING + j];
    }
  }

  /** First sample that is not complete yet. */
  get completeTo(): number {
    return this.done;
  }

  /** Free the ring for samples below `pos` (after `emit`). */
  release(pos: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const j = (pos + i) & MASK;
      this.acc[j] = 0;
      this.acc[RING + j] = 0;
      this.env[j] = 0;
    }
  }

  private frame(t: number): void {
    const { re, im, win, fft, xr, vr, acc, env, masks, g } = this;
    const s0 = HOP * t - HOP;
    for (let n = 0; n < N_FFT; n++) {
      const j = (s0 + n) & MASK;
      re[n] = (xr[j] - vr[j]) * win[n];
      im[n] = (xr[RING + j] - vr[RING + j]) * win[n];
    }
    fft.transform(re, im);
    if (t >= 0) {
      const m = (t & MMASK) * 2 * BINS;
      for (let k = KARAOKE_GATE_BIN; k < BINS; k++) {
        const nk = N_FFT - k;
        const lr = 0.5 * (re[k] + re[nk]);
        const li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]);
        const ri = -0.5 * (re[k] - re[nk]);
        const ml = masks[m + k], mr = masks[m + BINS + k];
        const gl = 1 - g * ml * ml, gr = 1 - g * mr * mr;
        const alr = lr * gl, ali = li * gl, arr = rr * gr, ari = ri * gr;
        re[k] = alr - ari;
        im[k] = ali + arr;
        re[nk] = alr + ari;
        im[nk] = arr - ali;
      }
    }
    fft.transform(re, im, true);
    for (let n = 0; n < N_FFT; n++) {
      const j = (s0 + n) & MASK;
      const w = win[n];
      acc[j] += (re[n] * w) / N_FFT;
      acc[RING + j] += (im[n] * w) / N_FFT;
      env[j] += w * w;
    }
    this.done = HOP * t; // the start of frame t + 1
  }
}
