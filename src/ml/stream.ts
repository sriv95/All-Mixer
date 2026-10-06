// Streaming Spleeter STFT → vocal mask around a model call. No ORT or DOM here, so Node can
// test it with a fake model. Matches spike/ml/spleeter_stream.py with --single --hop-frames 4
// --lookahead 2 --ctx 64: n_fft 4096, hop 1024, periodic Hann, magnitudes = |FFT| (scipy's ×n_fft/2
// undone), F = 1024 bins into the model, mask clip(v/(mag+1e-8), 0, 1).
// SRI-117: only the mask is produced (`masks`), for the Karaoke combine (src/ml/karaoke.ts); the vocal
// stems come from MDX-Net (src/ml/mdx.ts). The power-4 mask and frame gate of the A cappella path are gone.
//
// Frame grid. Frame t covers input [1024t − 1024, 1024t + 3072) of the stream (1024 samples of zero
// pre-roll; scipy's grid has 2048). After input block b (samples [4096b, 4096b + 4096)) the newest complete
// frame is t = 4b + 1. Output block b' = b − 1 (frames 4b − 4 … 4b − 1) needs the model window to end at frame
// 4b' + 3 + L = 4b + 1, i.e. just that frame, so each block returns exactly one 4-frame mask block.
// This is the python grid of spike/ml/hybrid_stream.py shifted by one frame: python STFT frame t + 1 = frame t here.
import { FFT } from './fft.js';

export const N_FFT = 4096;
export const HOP = 1024;
export const BINS = 1024;
export const CTX = 64;
/** Samples per Spleeter step (4 STFT hops). */
export const SPL_BLOCK = 4096;
export const HOP_FRAMES = SPL_BLOCK / HOP; // 4
const LOOKAHEAD = 2;
const FRAMES_PER_BLOCK = HOP_FRAMES;
const TENSOR_ROW = CTX * BINS;
export const TENSOR_LEN = 2 * TENSOR_ROW;
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
  private blocks = 0;

  constructor() {
    // periodic Hann (scipy get_window('hann') default)
    for (let i = 0; i < N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
    this.reset();
  }

  reset(): void {
    this.x.fill(0);
    this.tail.fill(0);
    this.blocks = 0;
  }

  /** Blocks analyzed so far; the next `masks` call returns frames HOP_FRAMES · (blocks − 1) − HOP_FRAMES … . */
  get blockCount(): number {
    return this.blocks;
  }

  /**
   * Block b in: `inL`/`inR` are SPL_BLOCK samples. STFT of frames 4b − 2 … 4b + 1, slid into `x`.
   * Follow with `model(x)` and `masks`.
   */
  analyze(inL: Float32Array, inR: Float32Array): void {
    const { x, re, im, win, fft, tail } = this;
    const keep = N_FFT - HOP; // 3072
    x.copyWithin(0, FRAMES_PER_BLOCK * BINS, TENSOR_ROW);
    x.copyWithin(TENSOR_ROW, TENSOR_ROW + FRAMES_PER_BLOCK * BINS, TENSOR_LEN);
    for (let f = 0; f < FRAMES_PER_BLOCK; f++) {
      // frame t = 4b − 2 + f starts at input 4096b − 3072 + 1024f: in `tail` (3072 old samples), then the block
      const start = HOP * f;
      for (let n = 0; n < N_FFT; n++) {
        const p = start + n;
        const l = p < keep ? tail[p] : inL[p - keep];
        const r = p < keep ? tail[keep + p] : inR[p - keep];
        re[n] = l * win[n];
        im[n] = r * win[n];
      }
      fft.transform(re, im);
      const row = CTX - FRAMES_PER_BLOCK + f;
      for (let k = 0; k < BINS; k++) {
        const nk = (N_FFT - k) & (N_FFT - 1);
        // two real signals in one complex FFT
        const lr = 0.5 * (re[k] + re[nk]);
        const li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]);
        const ri = -0.5 * (re[k] - re[nk]);
        x[row * BINS + k] = Math.hypot(lr, li);
        x[TENSOR_ROW + row * BINS + k] = Math.hypot(rr, ri);
      }
    }
    // keep the last 3072 samples
    for (let i = 0; i < keep; i++) {
      tail[i] = inL[SPL_BLOCK - keep + i];
      tail[keep + i] = inR[SPL_BLOCK - keep + i];
    }
  }

  /**
   * Model output `v` (vocal magnitudes for the window `analyze` just built) → the vocal mask
   * clip(v / (mag + 1e-8), 0, 1) of frames 4b − 4 … 4b − 1 (b = the block just analyzed), written as
   * dst[(f · 2 + ch) · BINS + k], f = 0 … 3. Returns the first frame index, 4b − 4.
   */
  masks(v: Float32Array, dst: Float32Array): number {
    const { x } = this;
    const b = this.blocks;
    const rowBase = CTX - HOP_FRAMES - LOOKAHEAD; // 58: frames 4b − 4 … 4b − 1
    for (let f = 0; f < HOP_FRAMES; f++) {
      for (let ch = 0; ch < 2; ch++) {
        const src = ch * TENSOR_ROW + (rowBase + f) * BINS;
        const o = (f * 2 + ch) * BINS;
        for (let k = 0; k < BINS; k++) dst[o + k] = clip01(v[src + k] / (x[src + k] + 1e-8));
      }
    }
    this.blocks++;
    return HOP_FRAMES * b - HOP_FRAMES;
  }
}

const clip01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
