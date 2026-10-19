// Drum stage: SCNet "Tran Small" (ZFTurbo Music-Source-Separation-Training, scripts/export-scnet.py) run on the
// instrumental to take the drums out of it. No ORT or DOM here, so Node can test it with a fake model.
//
// The graph holds the SCNet body only (what lies between torch.stft and torch.istft in SCNet_Tran.forward):
// input x [1, 4, 2049, 128], the STFT of a stereo chunk with the channels (L re, L im, R re, R im); output the
// same layout, drums only. The STFT / iSTFT are done here, as torch does them: n_fft 4096, hop 1024, rectangular
// window (SCNet passes none), normalized, centre reflect padding; the chunk is zero-padded by SC_PAD first so that
// the frame count is even-after-padding the way SCNet requires.
//
// Streaming: chunks of SC_CHUNK samples start every SC_STRIDE; neighbours overlap by SC_FADE and are cross-faded
// (sin² / cos², the weights add up to 1), so the bad edges of a chunk count little. Samples below `ready` are final.
// `ready` trails the pushed samples by less than SC_CHUNK: a block that ends at n is complete up to n − SC_LAG.
import { FFT } from './fft.js';

export const SC_NFFT = 4096;
export const SC_HOP = 1024;
export const SC_BINS = SC_NFFT / 2 + 1;
export const SC_FRAMES = 128;
/** Zero samples SCNet appends so that (length + pad) / hop is odd. */
const SC_PAD = 276;
/** Samples per model call: 2.94 s. */
export const SC_CHUNK = (SC_FRAMES - 1) * SC_HOP - SC_PAD;
/** Cross-fade between neighbouring chunks: 0.49 s. */
export const SC_FADE = 21 * SC_HOP;
export const SC_STRIDE = SC_CHUNK - SC_FADE;
/** Longest wait of a sample for its drums, rounded up to a render quantum (128). */
export const SC_LAG = Math.ceil(SC_CHUNK / 128) * 128;
/** Model input length. */
export const SC_INPUT = 4 * SC_BINS * SC_FRAMES;

const PADDED = SC_CHUNK + SC_PAD;
const PAD = SC_NFFT / 2;
const SPAN = (SC_FRAMES - 1) * SC_HOP + SC_NFFT; // OLA length before the centre trim

/** Model call: reads `x` [1, 4, 2049, 128], returns the drums, same layout. */
export type ScnetModelFn = (x: Float32Array) => Promise<Float32Array> | Float32Array;

/** One chunk through the model: STFT in, iSTFT out. */
export class ScnetChunk {
  /** Model input, owned by the chunk and refreshed in place. */
  readonly x = new Float32Array(SC_INPUT);

  private readonly fft = new FFT(SC_NFFT);
  private readonly re = new Float64Array(SC_NFFT);
  private readonly im = new Float64Array(SC_NFFT);
  private readonly ola = new Float64Array(2 * SPAN);
  /** 1 / (frames covering a sample) for the rectangular window. */
  private readonly inv = new Float64Array(SPAN);

  constructor() {
    const count = new Float64Array(SPAN);
    for (let t = 0; t < SC_FRAMES; t++) for (let n = 0; n < SC_NFFT; n++) count[t * SC_HOP + n]++;
    for (let i = 0; i < SPAN; i++) this.inv[i] = count[i] > 0 ? 1 / count[i] : 1;
  }

  /** `inL` / `inR`: SC_CHUNK samples. Fills `x`. */
  analyze(inL: Float32Array, inR: Float32Array): void {
    const { x, re, im, fft } = this;
    const scale = 1 / Math.sqrt(SC_NFFT);
    const F = SC_FRAMES, plane = SC_BINS * F;
    for (let t = 0; t < F; t++) {
      for (let n = 0; n < SC_NFFT; n++) {
        let s = t * SC_HOP + n - PAD; // reflect padding of the zero-padded chunk, torch centre=True
        if (s < 0) s = -s;
        else if (s >= PADDED) s = 2 * (PADDED - 1) - s;
        const live = s < SC_CHUNK;
        re[n] = live ? inL[s] : 0;
        im[n] = live ? inR[s] : 0;
      }
      fft.transform(re, im);
      for (let k = 0; k < SC_BINS; k++) {
        const nk = (SC_NFFT - k) & (SC_NFFT - 1);
        // two real signals in one complex FFT
        const o = k * F + t;
        x[o] = 0.5 * (re[k] + re[nk]) * scale;
        x[plane + o] = 0.5 * (im[k] - im[nk]) * scale;
        x[2 * plane + o] = 0.5 * (im[k] + im[nk]) * scale;
        x[3 * plane + o] = -0.5 * (re[k] - re[nk]) * scale;
      }
    }
  }

  /** Model output `y` for the chunk `analyze` just built → the drums, SC_CHUNK samples per channel. */
  synthesize(y: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const { re, im, fft, ola, inv } = this;
    const scale = 1 / Math.sqrt(SC_NFFT); // torch.istft(normalized=True) undoes the 1/√n of the forward; the inverse FFT's 1/n is applied here too
    const F = SC_FRAMES, plane = SC_BINS * F;
    ola.fill(0);
    for (let t = 0; t < F; t++) {
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < SC_BINS; k++) {
        const o = k * F + t;
        const yLr = y[o], yLi = y[plane + o], yRr = y[2 * plane + o], yRi = y[3 * plane + o];
        // Z = Y_L + i·Y_R packs both channels into one inverse FFT
        if (k === 0 || k === SC_BINS - 1) {
          // DC and Nyquist are real (irfft drops their imaginary part)
          re[k] = yLr;
          im[k] = yRr;
        } else {
          re[k] = yLr - yRi;
          im[k] = yLi + yRr;
          re[SC_NFFT - k] = yLr + yRi;
          im[SC_NFFT - k] = yRr - yLi;
        }
      }
      fft.transform(re, im, true);
      const s = t * SC_HOP;
      for (let n = 0; n < SC_NFFT; n++) {
        ola[s + n] += re[n] * scale;
        ola[SPAN + s + n] += im[n] * scale;
      }
    }
    for (let i = 0; i < SC_CHUNK; i++) {
      const a = PAD + i;
      outL[i] = ola[a] * inv[a];
      outR[i] = ola[SPAN + a] * inv[a];
    }
  }
}

const CAP = 2 ** 20;
const MASK = CAP - 1;
// A push of one block must leave room for the chunk behind it: block (≤ 15 s) + chunk + stride < CAP.
const MAX_PUSH = CAP - SC_CHUNK - SC_STRIDE;

/** Drums of a growing instrumental, chunk by chunk. */
export class DrumStage {
  readonly lag = SC_LAG;
  private readonly chunk = new ScnetChunk();
  private readonly inL = new Float32Array(CAP);
  private readonly inR = new Float32Array(CAP);
  private readonly drL = new Float32Array(CAP);
  private readonly drR = new Float32Array(CAP);
  private readonly cL = new Float32Array(SC_CHUNK);
  private readonly cR = new Float32Array(SC_CHUNK);
  private readonly oL = new Float32Array(SC_CHUNK);
  private readonly oR = new Float32Array(SC_CHUNK);
  private readonly fadeIn = Float32Array.from({ length: SC_FADE }, (_, i) => Math.sin((Math.PI / 2) * ((i + 0.5) / SC_FADE)) ** 2);
  private pushed = 0;
  private chunks = 0;

  reset(): void {
    this.inL.fill(0);
    this.inR.fill(0);
    this.drL.fill(0);
    this.drR.fill(0);
    this.pushed = 0;
    this.chunks = 0;
  }

  /** Samples pushed so far. */
  get length(): number {
    return this.pushed;
  }

  /** Drums of every sample below this are final. */
  get ready(): number {
    return this.chunks * SC_STRIDE;
  }

  /** Append instrumental samples (at most MAX_PUSH) and run every chunk that is now complete. */
  async push(l: Float32Array, r: Float32Array, n: number, model: ScnetModelFn): Promise<void> {
    if (n > MAX_PUSH) throw new Error('block too long for the drum stage');
    for (let i = 0; i < n; i++) {
      this.inL[(this.pushed + i) & MASK] = l[i];
      this.inR[(this.pushed + i) & MASK] = r[i];
    }
    this.pushed += n;
    while (this.chunks * SC_STRIDE + SC_CHUNK <= this.pushed) await this.run(model);
  }

  private async run(model: ScnetModelFn): Promise<void> {
    const { chunk, cL, cR, oL, oR, drL, drR, fadeIn } = this;
    const j = this.chunks, start = j * SC_STRIDE;
    for (let i = 0; i < SC_CHUNK; i++) {
      cL[i] = this.inL[(start + i) & MASK];
      cR[i] = this.inR[(start + i) & MASK];
    }
    chunk.analyze(cL, cR);
    chunk.synthesize(await model(chunk.x), oL, oR);
    // samples no earlier chunk has touched start from zero
    for (let i = j === 0 ? 0 : SC_FADE; i < SC_CHUNK; i++) {
      drL[(start + i) & MASK] = 0;
      drR[(start + i) & MASK] = 0;
    }
    for (let i = 0; i < SC_CHUNK; i++) {
      const w = j > 0 && i < SC_FADE ? fadeIn[i] : i >= SC_CHUNK - SC_FADE ? 1 - fadeIn[i - (SC_CHUNK - SC_FADE)] : 1;
      drL[(start + i) & MASK] += w * oL[i];
      drR[(start + i) & MASK] += w * oR[i];
    }
    this.chunks++;
  }

  /** Final drums of stream samples [start, start + n) (zero before the stream began); `start + n` must not pass `ready`. */
  read(start: number, n: number, outL: Float32Array, outR: Float32Array): void {
    for (let i = 0; i < n; i++) {
      const s = start + i;
      outL[i] = s >= 0 ? this.drL[s & MASK] : 0;
      outR[i] = s >= 0 ? this.drR[s & MASK] : 0;
    }
  }
}
