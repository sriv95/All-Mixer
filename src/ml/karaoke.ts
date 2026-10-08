// Karaoke combine (SRI-116 pick H3 p = 2, g = 0.8, spike/ml/hybrid_stream.py rows_for):
//   instrumental = (x − V_mdx) · max(1 − g · m², KARAOKE_FLOOR)   per STFT bin (floor 0.5, SRI-244/245), bins ≥ 150 Hz and < 1024, m = Spleeter vocal mask
// in the n_fft 4096 / hop 1024 STFT of x − V_mdx, then iSTFT / Σw² (steady state 1.5; the first 2048 samples
// use the real envelope, as scipy does). The MDX vocal stays the A cappella stem; this only changes the
// instrumental, which the worklet forms as x − Vk, so `emit` returns Vk = x − instrumental.
//
// Frame t covers input [1024t − 1024, 1024t + 3072) (the grid of SpleeterStream; python's STFT frame t + 1).
// Frame t is added once its 4096 samples of x − V exist; sample n is complete when every frame that covers it
// has been added, so the output lags the MDX vocal by at most one frame: KARAOKE_TAIL = 4096.
//
// Dip fill (SRI-220 G2, spike/ml/sri220_gate.py G2_mask_evidence, SRI-237): MDX sometimes drops a sung vowel
// (126 s on "lovely": 32 dB dip). In 100 – 1000 Hz, where the MDX vocal Vm is < 0.5 |Vs| and the mask ms > 0.3
// (Vs = ms · X, the Spleeter vocal), the vocal becomes Vz = Vm + g · (Vs − Vm). Both stems use Vz: instrumental
// (X − Vz) · (1 − g_k ms²), A cappella Vz. g per frame = hann5(ramp(mw, 0.3, 0.5) · [eS > floor]), mw = |X|-weighted
// mean mask in the band, eS = Spleeter band energy (dB). A pause (mask < 0.3) keeps g = 0 and the output is the
// plain combine, bit for bit. The hann5 smoothing looks ±2 frames, but g needs only x and the masks, which are
// ~2 s ahead of the MDX vocal, so it adds no latency: the combine only waits for mask t + 2 (GATE_LOOKAHEAD).
// Floor: the offline spec uses P95(eS) − 40 dB over the clip. A stream has no clip; the floor is a peak hold of eS
// (decay FILL_DECAY_DB_S, never below FILL_PEAK_MIN_DB) minus FILL_FLOOR_DB. The peak minimum keeps the floor from
// drifting to digital silence in a long pause, where a rising noise floor would otherwise open the gate.
//
// Everything is in absolute stream positions in power-of-two rings. No allocation after construction.
import { FFT } from './fft.js';
import { BINS, HOP, N_FFT } from './stream';

/** Margin g (runtime constant, tune after listening). */
export const KARAOKE_G = 0.8;
/** Instrumental gain floor (SRI-244/245): the gain 1 − g · m² never goes below this, so a sung part keeps its backing. */
export const KARAOKE_FLOOR = 0.5;
export const KARAOKE_GATE_HZ = 150;
const SAMPLE_RATE = 44100;
/** First bin with frequency ≥ KARAOKE_GATE_HZ. */
export const KARAOKE_GATE_BIN = Math.ceil((KARAOKE_GATE_HZ * N_FFT) / SAMPLE_RATE);
/** Dip-fill band (Hz), bins [FILL_LO, FILL_HI], and its thresholds. */
export const FILL_LO = Math.ceil((100 * N_FFT) / SAMPLE_RATE);
export const FILL_HI = Math.floor((1000 * N_FFT) / SAMPLE_RATE);
export const FILL_A = 0.5;
export const FILL_T = 0.3;
export const FILL_M0 = 0.3;
export const FILL_M1 = 0.5;
export const FILL_FLOOR_DB = 40;
export const FILL_DECAY_DB_S = 1;
export const FILL_PEAK_MIN_DB = 15;
/** Mask frames the combine needs beyond the frame it adds (hann5 looks ±2). */
export const GATE_LOOKAHEAD = 2;
/** hann(7) without its zero ends, sum 1 (np.hanning(7)[1:-1] / sum). */
const SMOOTH = [0.25 / 3, 0.75 / 3, 1 / 3, 0.75 / 3, 0.25 / 3];
const RING = 131072; // > 2 · 34304 + 4096, power of two
const MASK = RING - 1;
const MRING = 128; // mask frames kept; the producer is at most ~40 frames ahead of the consumer
const MMASK = MRING - 1;

export class KaraokeCombiner {
  private readonly fft = new FFT(N_FFT);
  private readonly win = new Float64Array(N_FFT);
  private readonly re = new Float64Array(N_FFT);
  private readonly im = new Float64Array(N_FFT);
  private readonly re2 = new Float64Array(N_FFT);
  private readonly im2 = new Float64Array(N_FFT);
  private readonly re3 = new Float64Array(N_FFT);
  private readonly im3 = new Float64Array(N_FFT);
  /** Raw (unsmoothed) gate per frame, ring of 8 by frame & 7. */
  private readonly rawG = new Float64Array(8);
  /** Newest frame whose raw gate is computed. */
  private rawTo = -1;
  /** Running peak of the band energy eS (dB). */
  private peak = FILL_PEAK_MIN_DB;
  /** Input ends here. */
  private inTo = 0;
  /** Input and MDX vocal, [L: RING][R: RING], by absolute position. */
  private readonly xr = new Float32Array(2 * RING);
  private readonly vr = new Float32Array(2 * RING);
  /** iSTFT overlap-add of the instrumental and of Σw². */
  private readonly acc = new Float32Array(2 * RING);
  private readonly env = new Float32Array(RING);
  /** iSTFT overlap-add of the vocal change g · (Vs − Vm). */
  private readonly dv = new Float32Array(2 * RING);
  /** Spleeter vocal masks, [frame & MMASK][2][BINS]. */
  private readonly masks = new Float32Array(MRING * 2 * BINS);
  /** Next frame to add. Frame −1 (start −2048) is the first one python has. */
  private next = -1;
  /** Newest mask frame stored. */
  private maskTo = -1;
  /** Samples below this are complete (frames covering them are all added). */
  private done = 0;

  /** The running floor (dB) the band energy must exceed to open the gate. */
  get floorDb(): number {
    return this.peak - FILL_FLOOR_DB;
  }

  constructor(readonly g: number = KARAOKE_G, readonly fill = true) {
    for (let i = 0; i < N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  }

  reset(): void {
    this.xr.fill(0);
    this.vr.fill(0);
    this.acc.fill(0);
    this.env.fill(0);
    this.dv.fill(0);
    this.rawG.fill(0);
    this.rawTo = -1;
    this.peak = FILL_PEAK_MIN_DB;
    this.inTo = 0;
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
    if (pos + n > this.inTo) this.inTo = pos + n;
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

  /**
   * Add every frame whose 4096 samples end at or before `limit` and whose mask is stored (with the masks and input of
   * the GATE_LOOKAHEAD frames after it). With `force`, frames whose mask is missing are added too, with mask 0
   * (ungated x − V_mdx, SRI-130); their late masks are then unused, and a missing look-ahead counts as gate 0.
   */
  advance(limit: number, force = false): void {
    const ahead = HOP * GATE_LOOKAHEAD;
    while (
      HOP * this.next - HOP + N_FFT <= limit &&
      (force || (this.next + GATE_LOOKAHEAD <= this.maskTo && HOP * this.next - HOP + N_FFT + ahead <= this.inTo))
    ) this.frame(this.next++);
  }

  /** Frame index the next `advance` needs a mask for, given the samples available up to `limit`. */
  neededMask(limit: number): number {
    return Math.floor((limit - N_FFT + HOP) / HOP) + GATE_LOOKAHEAD;
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

  /** The vocal Vz for [pos, pos + n) (A cappella stem): the MDX vocal plus the dip fill. */
  emitVocal(pos: number, n: number, outL: Float32Array, outR: Float32Array): void {
    const { vr, dv, env } = this;
    for (let i = 0; i < n; i++) {
      const j = (pos + i) & MASK;
      const e = env[j] > 1e-10 ? 1 / env[j] : 1;
      outL[i] = vr[j] + dv[j] * e;
      outR[i] = vr[RING + j] + dv[RING + j] * e;
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
      this.dv[j] = 0;
      this.dv[RING + j] = 0;
      this.env[j] = 0;
    }
  }

  /** Raw gate of frame u from x and the mask (python frame u + 1); 0 when either is missing. Frames run in order. */
  private evidence(u: number): void {
    const { re2: re, im2: im, win, fft, xr, masks } = this;
    let raw = 0;
    const s0 = HOP * u - HOP;
    if (u >= 0 && u <= this.maskTo && s0 + N_FFT <= this.inTo) {
      for (let n = 0; n < N_FFT; n++) {
        const j = (s0 + n) & MASK;
        re[n] = xr[j] * win[n];
        im[n] = xr[RING + j] * win[n];
      }
      fft.transform(re, im);
      const m = (u & MMASK) * 2 * BINS;
      let sx = 0, sm = 0, es = 0;
      for (let k = FILL_LO; k <= FILL_HI; k++) {
        const nk = N_FFT - k;
        const lr = 0.5 * (re[k] + re[nk]), li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]), ri = -0.5 * (re[k] - re[nk]);
        const al = Math.hypot(lr, li), ar = Math.hypot(rr, ri);
        const ml = masks[m + k], mr = masks[m + BINS + k];
        sx += al + ar;
        sm += ml * al + mr * ar;
        es += (ml * al) ** 2 + (mr * ar) ** 2 + 2e-9;
      }
      const nb = FILL_HI - FILL_LO + 1;
      const eS = 10 * Math.log10(es / (2 * nb));
      this.peak = Math.max(eS, this.peak - (FILL_DECAY_DB_S * HOP) / SAMPLE_RATE, FILL_PEAK_MIN_DB);
      const mw = sm / (sx + 1e-9);
      const ramp = Math.min(1, Math.max(0, (mw - FILL_M0) / (FILL_M1 - FILL_M0)));
      raw = eS > this.peak - FILL_FLOOR_DB ? ramp : 0;
    }
    this.rawG[u & 7] = raw;
  }

  /** hann5 of the raw gate around frame t (frames before the stream count 0). */
  private gate(t: number): number {
    while (this.rawTo < t + GATE_LOOKAHEAD) this.evidence(++this.rawTo);
    let g = 0;
    for (let j = -2; j <= 2; j++) if (t + j >= 0) g += SMOOTH[j + 2] * this.rawG[(t + j) & 7];
    return g;
  }

  private frame(t: number): void {
    const { re, im, re2, im2, re3, im3, win, fft, xr, vr, acc, env, dv, masks, g } = this;
    const gt = this.fill && t >= 0 ? this.gate(t) : 0;
    const s0 = HOP * t - HOP;
    for (let n = 0; n < N_FFT; n++) {
      const j = (s0 + n) & MASK;
      re[n] = (xr[j] - vr[j]) * win[n];
      im[n] = (xr[RING + j] - vr[RING + j]) * win[n];
    }
    fft.transform(re, im);
    const filling = gt > 0;
    if (filling) {
      for (let n = 0; n < N_FFT; n++) {
        const j = (s0 + n) & MASK;
        re2[n] = vr[j] * win[n];
        im2[n] = vr[RING + j] * win[n];
      }
      fft.transform(re2, im2);
      re3.fill(0);
      im3.fill(0);
    }
    if (t >= 0) {
      const have = t <= this.maskTo;
      const m = (t & MMASK) * 2 * BINS;
      for (let k = filling ? FILL_LO : KARAOKE_GATE_BIN; k < BINS; k++) {
        const nk = N_FFT - k;
        let lr = 0.5 * (re[k] + re[nk]);
        let li = 0.5 * (im[k] - im[nk]);
        let rr = 0.5 * (im[k] + im[nk]);
        let ri = -0.5 * (re[k] - re[nk]);
        const ml = have ? masks[m + k] : 0, mr = have ? masks[m + BINS + k] : 0;
        if (filling && k <= FILL_HI) {
          // D = X − Vm; X = D + Vm; Vs = ms · X; fill where |Vm| < a |Vs| and ms > t: D −= g (Vs − Vm).
          const vlr = 0.5 * (re2[k] + re2[nk]), vli = 0.5 * (im2[k] - im2[nk]);
          const vrr = 0.5 * (im2[k] + im2[nk]), vri = -0.5 * (re2[k] - re2[nk]);
          let dlr = 0, dli = 0, drr = 0, dri = 0;
          if (ml > FILL_T) {
            const xlr = lr + vlr, xli = li + vli;
            const sr = ml * xlr, si = ml * xli;
            if (vlr * vlr + vli * vli < FILL_A * FILL_A * (sr * sr + si * si)) {
              dlr = gt * (sr - vlr);
              dli = gt * (si - vli);
              lr -= dlr;
              li -= dli;
            }
          }
          if (mr > FILL_T) {
            const xrr = rr + vrr, xri = ri + vri;
            const sr = mr * xrr, si = mr * xri;
            if (vrr * vrr + vri * vri < FILL_A * FILL_A * (sr * sr + si * si)) {
              drr = gt * (sr - vrr);
              dri = gt * (si - vri);
              rr -= drr;
              ri -= dri;
            }
          }
          re3[k] = dlr - dri;
          im3[k] = dli + drr;
          re3[nk] = dlr + dri;
          im3[nk] = drr - dli;
        }
        if (k < KARAOKE_GATE_BIN) {
          re[k] = lr - ri;
          im[k] = li + rr;
          re[nk] = lr + ri;
          im[nk] = rr - li;
          continue;
        }
        const gl = Math.max(1 - g * ml * ml, KARAOKE_FLOOR), gr = Math.max(1 - g * mr * mr, KARAOKE_FLOOR);
        const alr = lr * gl, ali = li * gl, arr = rr * gr, ari = ri * gr;
        re[k] = alr - ari;
        im[k] = ali + arr;
        re[nk] = alr + ari;
        im[nk] = arr - ali;
      }
    }
    fft.transform(re, im, true);
    if (filling) fft.transform(re3, im3, true);
    for (let n = 0; n < N_FFT; n++) {
      const j = (s0 + n) & MASK;
      const w = win[n];
      acc[j] += (re[n] * w) / N_FFT;
      acc[RING + j] += (im[n] * w) / N_FFT;
      if (filling) {
        dv[j] += (re3[n] * w) / N_FFT;
        dv[RING + j] += (im3[n] * w) / N_FFT;
      }
      env[j] += w * w;
    }
    this.done = HOP * t; // the start of frame t + 1
  }
}
