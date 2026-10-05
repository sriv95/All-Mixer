// Streaming Spleeter STFT → mask → ISTFT around a model call. No ORT or DOM here, so Node can
// test it with a fake model. Matches spike/ml/spleeter_stream.py separate() with
// --single --hop-frames 4 --lookahead 2 --ctx 64: n_fft 4096, hop 1024, periodic Hann,
// magnitudes = |FFT| (scipy's ×n_fft/2 undone), F = 1024 bins into the model, mask
// clip(v/(mag+1e-8), 0, 1), bins ≥ 1024 get mask 0, overlap-add ISTFT / Σw² (= 1.5).
// Optional second vocal stem with --voc-power P_ACAP·a (--voc-hpf 0): mask m^p_eff, p_eff = 1 + (P−1)·a
// (a = clamp(1 − instrumentalGain, 0, 1), setSharpen). The soft-mask vocal is always produced too, so
// the instrumental x − soft is Karaoke's and a = 0 is bit-identical to before. No per-block allocation.
//
// Frame grid and ML_RESULT_OFFSET. Frame t covers input [1024t − 1024, 1024t + 3072) of the
// stream (1024 samples of zero pre-roll; scipy's grid has 2048, see below). After input block b
// (samples [4096b, 4096b + 4096)) the newest complete frame is t = 4b + 1. Output block b' = b − 1
// (frames 4b − 4 … 4b − 1) needs the model window to end at frame 4b' + 3 + L = 4b + 1, i.e. just
// that frame, so each block returns exactly one 4-frame mask block. Overlap-add of those frames is
// complete for samples n < 1024(4b − 1) + 1024 = 4096b − 1024, so the returned block covers
// [4096b − 5120, 4096b − 1024): ML_RESULT_OFFSET = 5120 = 4096 (n_fft) + 1024 (the pre-roll).
// scipy's boundary='zeros' pre-roll is 2048 and would give 6144; 1024 is the smallest pre-roll that
// still lets block b' = b − 1 run. The frame grid is therefore the python one on a stream
// delayed by 1024 samples (the same model windows and masks, 1024 samples earlier in the output).
import { FFT } from '../worklet/dsp/fft.js';
import { ML_BLOCK } from '../worklet/protocol';

export const N_FFT = 4096;
export const HOP = 1024;
export const BINS = 1024;
export const CTX = 64;
export const HOP_FRAMES = ML_BLOCK / HOP; // 4
const LOOKAHEAD = 2;
/** Samples of the stream before sample 0 that the first frame sees as zeros. */
export const PREROLL = 1024;
const FRAMES_PER_BLOCK = HOP_FRAMES;
const ZRING = 8;
const ACC = 8192; // > 4096 + 3·1024 spread of one output block's frames
const TENSOR_ROW = CTX * BINS;
export const TENSOR_LEN = 2 * TENSOR_ROW;
/** A cappella vocal mask power (SRI-65: p 2.25 with no HPF meets the bar on the 50-clip bench). */
export const P_ACAP = 2.25;

/** Model call: reads `x` ([2,1,64,1024] magnitudes), returns the vocal magnitudes, same shape. */
export type ModelFn = (x: Float32Array) => Promise<Float32Array> | Float32Array;

export class SpleeterStream {
  /** Model input, [2][64][1024]; slid by one block per call. Owned by the stream, reused. */
  readonly x = new Float32Array(TENSOR_LEN);

  private readonly fft = new FFT(N_FFT);
  private readonly win = new Float64Array(N_FFT);
  private readonly re = new Float64Array(N_FFT);
  private readonly im = new Float64Array(N_FFT);
  /** Last 3072 input samples per channel, ahead of the next block. */
  private readonly tail = new Float32Array(2 * (N_FFT - HOP));
  private readonly zRe = new Float32Array(ZRING * 2 * BINS);
  private readonly zIm = new Float32Array(ZRING * 2 * BINS);
  private readonly acc = new Float32Array(2 * ACC);
  /** Overlap-add of the sharpened vocal (only used while sharpen > 0). */
  private readonly accS = new Float32Array(2 * ACC);
  /** a = clamp(1 − instrumentalGain, 0, 1): how far the vocal mask is sharpened. */
  private sharpen = 0;
  /** The previous block ran the sharp path, so `accS` may differ from `acc` (pending tails). */
  private sharpPrev = false;
  private blocks = 0;

  constructor() {
    // periodic Hann (scipy get_window('hann') default)
    for (let i = 0; i < N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
    this.reset();
  }

  /**
   * a = clamp(1 − instrumentalGain, 0, 1), taken per block. The sharpened vocal uses mask m^p_eff,
   * p_eff = 1 + (P_ACAP − 1)·a. Takes effect from the next `synthesize`; `reset()` keeps it.
   */
  setSharpen(a: number): void {
    this.sharpen = a > 0 ? (a < 1 ? a : 1) : 0;
  }

  reset(): void {
    this.x.fill(0);
    this.tail.fill(0);
    this.zRe.fill(0);
    this.zIm.fill(0);
    this.acc.fill(0);
    this.accS.fill(0);
    this.sharpPrev = false;
    this.blocks = 0;
  }

  /**
   * Block b in: `inL`/`inR` are ML_BLOCK samples. STFT of frames 4b − 2 … 4b + 1, slid into `x`.
   * Follow with `model(x)` and `synthesize`.
   */
  analyze(inL: Float32Array, inR: Float32Array): void {
    const { x, re, im, win, fft, tail } = this;
    const keep = N_FFT - HOP; // 3072
    const b = this.blocks;
    x.copyWithin(0, FRAMES_PER_BLOCK * BINS, TENSOR_ROW);
    x.copyWithin(TENSOR_ROW, TENSOR_ROW + FRAMES_PER_BLOCK * BINS, TENSOR_LEN);
    for (let f = 0; f < FRAMES_PER_BLOCK; f++) {
      const t = FRAMES_PER_BLOCK * b - 2 + f;
      // frame t starts at input 1024t − 1024 = 4096b − 3072 + 1024f: in `tail` (3072 old samples), then the block
      const start = HOP * f;
      for (let n = 0; n < N_FFT; n++) {
        const p = start + n;
        const l = p < keep ? tail[p] : inL[p - keep];
        const r = p < keep ? tail[keep + p] : inR[p - keep];
        re[n] = l * win[n];
        im[n] = r * win[n];
      }
      fft.transform(re, im);
      const slot = (t & (ZRING - 1)) * 2 * BINS;
      const row = CTX - FRAMES_PER_BLOCK + f;
      for (let k = 0; k < BINS; k++) {
        const nk = (N_FFT - k) & (N_FFT - 1);
        // two real signals in one complex FFT
        const lr = 0.5 * (re[k] + re[nk]);
        const li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]);
        const ri = -0.5 * (re[k] - re[nk]);
        this.zRe[slot + k] = lr;
        this.zIm[slot + k] = li;
        this.zRe[slot + BINS + k] = rr;
        this.zIm[slot + BINS + k] = ri;
        x[row * BINS + k] = Math.hypot(lr, li);
        x[TENSOR_ROW + row * BINS + k] = Math.hypot(rr, ri);
      }
    }
    // keep the last 3072 samples
    for (let i = 0; i < keep; i++) {
      tail[i] = inL[ML_BLOCK - keep + i];
      tail[keep + i] = inR[ML_BLOCK - keep + i];
    }
  }

  /**
   * Model output `v` (vocal magnitudes for the window `analyze` just built) → the vocal block
   * [blockStart − ML_RESULT_OFFSET, … + ML_BLOCK) (see header), written to outL/outR. This is the
   * soft-mask vocal; the worklet's instrumental is x − this, so it never depends on `sharpen`.
   * If `shL`/`shR` are given they get the sharpened vocal stem (mask m^p_eff, see `setSharpen`);
   * with sharpen 0 that is a bit copy of outL/outR, otherwise a second inverse FFT per frame.
   */
  synthesize(v: Float32Array, outL: Float32Array, outR: Float32Array, shL?: Float32Array, shR?: Float32Array): void {
    const { acc, accS } = this;
    const b = this.blocks;
    const pEff = 1 + (P_ACAP - 1) * this.sharpen;
    // Sharp path while pEff ≠ 1, plus one more block after it (pw = 1) to flush the old sharp tails.
    const sharp = shL !== undefined && shR !== undefined && (pEff !== 1 || this.sharpPrev);
    // Entry: until now sharp == soft, so the soft tails are exactly the pending sharp tails.
    if (sharp && !this.sharpPrev) accS.set(acc);
    for (let f = 0; f < HOP_FRAMES; f++) {
      const t = HOP_FRAMES * b - HOP_FRAMES + f;
      this.frame(v, t, f, 1, acc);
      if (sharp) this.frame(v, t, f, pEff, accS);
    }
    // Complete now: [4096b − 5120, 4096b − 1024). Emit and clear.
    const o0 = ML_BLOCK * b - (ML_BLOCK + PREROLL);
    for (let n = 0; n < ML_BLOCK; n++) {
      const j = (o0 + n) & (ACC - 1);
      outL[n] = acc[j];
      outR[n] = acc[ACC + j];
      acc[j] = 0;
      acc[ACC + j] = 0;
      if (shL !== undefined && shR !== undefined) {
        if (sharp) {
          shL[n] = accS[j];
          shR[n] = accS[ACC + j];
          accS[j] = 0;
          accS[ACC + j] = 0;
        } else {
          shL[n] = outL[n];
          shR[n] = outR[n];
        }
      }
    }
    this.sharpPrev = sharp && pEff !== 1;
    this.blocks++;
  }

  /** Mask frame t (window row 58 + f), mask power `pw` (1 = exact m), overlap-added into `into`. */
  private frame(v: Float32Array, t: number, f: number, pw: number, into: Float32Array): void {
    const { x, re, im, win, fft } = this;
    const slot = (t & (ZRING - 1)) * 2 * BINS;
    const row = CTX - HOP_FRAMES - LOOKAHEAD + f; // 58: frames 4b − 4 … 4b − 1
    const norm = 1 / (1.5 * N_FFT);
    re.fill(0);
    im.fill(0);
    for (let k = 0; k < BINS; k++) {
      let ml = clip01(v[row * BINS + k] / (x[row * BINS + k] + 1e-8));
      let mr = clip01(v[TENSOR_ROW + row * BINS + k] / (x[TENSOR_ROW + row * BINS + k] + 1e-8));
      if (pw !== 1) {
        ml = Math.pow(ml, pw);
        mr = Math.pow(mr, pw);
      }
      const lr = this.zRe[slot + k] * ml, li = this.zIm[slot + k] * ml;
      const rr = this.zRe[slot + BINS + k] * mr, ri = this.zIm[slot + BINS + k] * mr;
      re[k] = lr - ri;
      im[k] = li + rr;
      if (k > 0) {
        re[N_FFT - k] = lr + ri;
        im[N_FFT - k] = rr - li;
      }
    }
    fft.transform(re, im, true);
    // frame t starts at stream sample 1024t − 1024
    const s0 = HOP * t - PREROLL;
    for (let n = 0; n < N_FFT; n++) {
      const j = (s0 + n) & (ACC - 1);
      into[j] += re[n] * win[n] * norm;
      into[ACC + j] += im[n] * win[n] * norm;
    }
  }

  /** analyze + model + synthesize. */
  async process(
    inL: Float32Array,
    inR: Float32Array,
    model: ModelFn,
    outL: Float32Array,
    outR: Float32Array,
    shL?: Float32Array,
    shR?: Float32Array,
  ): Promise<void> {
    this.analyze(inL, inR);
    const v = await model(this.x);
    this.synthesize(v, outL, outR, shL, shR);
  }
}

const clip01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
