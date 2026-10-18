// Streaming Mel-Band RoFormer (fp16 core, scripts/export-roformer.py) around a model call. No ORT or DOM here, so
// Node can test it with a fake model. The graph holds only the transformer stack: the STFT, the gather of the
// mel-band bins, the mask scatter-add and the iSTFT are done here, as in MelBandRoformer.forward
// (torch.stft n_fft 2048 / hop 441 / periodic Hann / centre reflect padding, torch.istft).
//
// Block b in = input [b·H, (b + 1)·H), H = ROF_BLOCK. The chunk is the 9271 samples before it plus the block
// (ROF_CHUNK = 111 hops → 112 frames). The vocal block it completes is input [b·H − R, (b + 1)·H − R), R = ROF_OVERLAP:
// the first R samples cross-fade with the tail of the previous chunk (its last R samples), and the first
// K − R = 439 samples of the chunk are context only. Delay before inference: H + R.
import { FFT } from './fft.js';
import { ROF_BLOCK, ROF_CHUNK, ROF_OVERLAP } from '../worklet/protocol';

const N_FFT = 2048;
const HOP = 441;
const BINS = N_FFT / 2 + 1;
const FS = 2 * BINS; // (bin, channel) interleaved
const C = ROF_CHUNK;
const H = ROF_BLOCK;
const R = ROF_OVERLAP;
const K = C - H; // history
const E = K - R; // context-only prefix of the emitted region
export const ROF_FRAMES = Math.floor(C / HOP) + 1;
const PAD = N_FFT / 2;

/** public/ml/roformer-meta.json */
export interface RoformerMeta {
  frames: number;
  chunk: number;
  nFft: number;
  hop: number;
  /** Per model input value: index into the interleaved (bin·2 + channel) axis. */
  sel: number[];
  /** Mel bands covering each bin. */
  bands: number[];
}

/** Model call: reads `x` ([1, 112, sel.length · 2]), returns the masks, same layout. */
export type RoformerModelFn = (x: Float32Array) => Promise<Float32Array> | Float32Array;

export class RoformerStream {
  /** Model input, owned by the stream and refreshed in place. */
  readonly x: Float32Array;

  private readonly sel: Int32Array;
  private readonly invBands: Float32Array;
  private readonly fin: number;
  private readonly fft = new FFT(N_FFT);
  private readonly win = new Float64Array(N_FFT);
  private readonly re = new Float64Array(N_FFT);
  private readonly im = new Float64Array(N_FFT);
  /** Chunk, [L: C][R: C]. */
  private readonly chunk = new Float32Array(2 * C);
  /** Spectra of the chunk, [ch][t][bin]. */
  private readonly specRe = new Float32Array(2 * ROF_FRAMES * BINS);
  private readonly specIm = new Float32Array(2 * ROF_FRAMES * BINS);
  /** Mask sums per (frame, bin·2 + channel). */
  private readonly accRe = new Float32Array(ROF_FRAMES * FS);
  private readonly accIm = new Float32Array(ROF_FRAMES * FS);
  /** iSTFT overlap-add, [L: padded][R: padded]. */
  private readonly ola: Float64Array;
  private readonly padded = C + N_FFT;
  /** 1 / Σw² per padded sample. */
  private readonly norm: Float64Array;
  /** Cross-fade ramp (rises over R) and the last R output samples of the previous chunk, [L: R][R: R]. */
  private readonly ramp = new Float32Array(R);
  private readonly tail = new Float32Array(2 * R);

  constructor(meta: RoformerMeta) {
    if (meta.frames !== ROF_FRAMES || meta.chunk !== C || meta.nFft !== N_FFT || meta.hop !== HOP) {
      throw new Error('roformer meta does not match the stream geometry');
    }
    this.sel = Int32Array.from(meta.sel);
    this.fin = this.sel.length * 2;
    this.x = new Float32Array(ROF_FRAMES * this.fin);
    this.invBands = Float32Array.from(meta.bands, (b) => 1 / Math.max(b, 1e-8));
    this.ola = new Float64Array(2 * this.padded);
    for (let i = 0; i < N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
    const env = new Float64Array(this.padded);
    for (let t = 0; t < ROF_FRAMES; t++) for (let n = 0; n < N_FFT; n++) env[t * HOP + n] += this.win[n] * this.win[n];
    this.norm = env.map((e) => (e > 1e-11 ? 1 / e : 1));
    for (let i = 0; i < R; i++) this.ramp[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / R);
  }

  reset(): void {
    this.chunk.fill(0);
    this.tail.fill(0);
  }

  /** Block b in (`inL`/`inR`: ROF_BLOCK samples): slide the chunk, STFT its frames, gather the model input into `x`. */
  analyze(inL: Float32Array, inR: Float32Array): void {
    const { chunk, win, re, im, fft, specRe, specIm, x, sel, fin } = this;
    chunk.copyWithin(0, H, C);
    chunk.copyWithin(C, C + H, 2 * C);
    chunk.set(inL.subarray(0, H), K);
    chunk.set(inR.subarray(0, H), C + K);
    for (let t = 0; t < ROF_FRAMES; t++) {
      for (let n = 0; n < N_FFT; n++) {
        let s = t * HOP + n - PAD; // reflect padding, torch centre=True
        if (s < 0) s = -s;
        else if (s >= C) s = 2 * (C - 1) - s;
        re[n] = chunk[s] * win[n];
        im[n] = chunk[C + s] * win[n];
      }
      fft.transform(re, im);
      for (let k = 0; k < BINS; k++) {
        const nk = (N_FFT - k) & (N_FFT - 1);
        // two real signals in one complex FFT
        const o = t * BINS + k;
        specRe[o] = 0.5 * (re[k] + re[nk]);
        specIm[o] = 0.5 * (im[k] - im[nk]);
        specRe[ROF_FRAMES * BINS + o] = 0.5 * (im[k] + im[nk]);
        specIm[ROF_FRAMES * BINS + o] = -0.5 * (re[k] - re[nk]);
      }
      const row = t * fin;
      for (let j = 0; j < sel.length; j++) {
        const fs = sel[j];
        const o = (fs & 1) * ROF_FRAMES * BINS + t * BINS + (fs >> 1);
        x[row + 2 * j] = specRe[o];
        x[row + 2 * j + 1] = specIm[o];
      }
    }
  }

  /**
   * Masks `m` for the chunk `analyze` just built → the vocal block for input [b·H − R, (b + 1)·H − R),
   * written to outL/outR (ROF_BLOCK samples each).
   */
  synthesize(m: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const { sel, fin, accRe, accIm, invBands, specRe, specIm, re, im, win, fft, ola, norm, padded, ramp, tail } = this;
    // masks of the bands that overlap a bin, averaged
    accRe.fill(0);
    accIm.fill(0);
    for (let t = 0; t < ROF_FRAMES; t++) {
      const row = t * fin, base = t * FS;
      for (let j = 0; j < sel.length; j++) {
        accRe[base + sel[j]] += m[row + 2 * j];
        accIm[base + sel[j]] += m[row + 2 * j + 1];
      }
    }
    ola.fill(0);
    const P = ROF_FRAMES * BINS;
    for (let t = 0; t < ROF_FRAMES; t++) {
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < BINS; k++) {
        // Y = X · mask per channel; Z = Y_L + i·Y_R packs both channels into one inverse FFT
        const w = invBands[k];
        const aL = t * FS + 2 * k, aR = aL + 1;
        const mLr = accRe[aL] * w, mLi = accIm[aL] * w, mRr = accRe[aR] * w, mRi = accIm[aR] * w;
        const oL = t * BINS + k, oR = P + oL;
        const yLr = specRe[oL] * mLr - specIm[oL] * mLi, yLi = specRe[oL] * mLi + specIm[oL] * mLr;
        const yRr = specRe[oR] * mRr - specIm[oR] * mRi, yRi = specRe[oR] * mRi + specIm[oR] * mRr;
        if (k === 0 || k === BINS - 1) {
          // DC and Nyquist are real (irfft drops their imaginary part)
          re[k] = yLr;
          im[k] = yRr;
        } else {
          re[k] = yLr - yRi;
          im[k] = yLi + yRr;
          re[N_FFT - k] = yLr + yRi;
          im[N_FFT - k] = yRr - yLi;
        }
      }
      fft.transform(re, im, true);
      const s = t * HOP;
      for (let n = 0; n < N_FFT; n++) {
        ola[s + n] += (re[n] * win[n]) / N_FFT;
        ola[padded + s + n] += (im[n] * win[n]) / N_FFT;
      }
    }
    for (let i = 0; i < H; i++) {
      const a = PAD + E + i;
      const l = ola[a] * norm[a], r = ola[padded + a] * norm[a];
      if (i < R) {
        outL[i] = tail[i] * (1 - ramp[i]) + l * ramp[i];
        outR[i] = tail[R + i] * (1 - ramp[i]) + r * ramp[i];
      } else {
        outL[i] = l;
        outR[i] = r;
      }
    }
    for (let i = 0; i < R; i++) {
      const a = PAD + E + H + i;
      tail[i] = ola[a] * norm[a];
      tail[R + i] = ola[padded + a] * norm[a];
    }
  }

  /** analyze + model + synthesize. */
  async process(inL: Float32Array, inR: Float32Array, model: RoformerModelFn, outL: Float32Array, outR: Float32Array): Promise<void> {
    this.analyze(inL, inR);
    const m = await model(this.x);
    this.synthesize(m, outL, outR);
  }
}
