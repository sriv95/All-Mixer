// Streaming UVR MDX-Net 9482 (T = 64) around a model call. No ORT or DOM here, so Node can test it
// with a fake model. Matches spike/ml/mdx_stream.py separate(): n_fft 4096, hop 1024, periodic Hann,
// segments of T = 64 frames without centre padding (N = 68608 samples) every N / 2 samples (50 % overlap),
// model input [1, 4, 2048, T] = Re/Im of L and R (true FFT of the windowed frame, bins 0 … 2047),
// output the vocal in the same layout (bin 2048 = 0), iSTFT / Σw² (scipy's NOLA envelope, edges too),
// then a periodic Hann cross-fade over the whole segment (overlap-add at hop N / 2 sums to 1).
//
// Block b in = input [b·H, (b + 1)·H), H = N / 2 (ML_BLOCK for the default 64 frames). The segment of block b is [block b − 1, block b]
// (block −1 = zeros, the python left pad). The vocal block it completes is input [(b − 1)·H, b·H): the first
// half of this segment plus the second half of the previous one. So a cross-fade region waits for N input
// samples (= 2 H) after its first sample: that is the algorithmic delay, before inference.
import { FFT } from './fft.js';
import { mdxSegment } from './mdx-plan';

const MDX_N_FFT = 4096;
const MDX_HOP = 1024;
export const MDX_BINS = 2048;
/** Default segment: 64 frames. Longer ones (a multiple of 32, src/ml/mdx-plan.ts) buy more context for a longer delay. */
export const MDX_T = 64;

/** Model call: reads `x` ([1, 4, 2048, 64]), returns the vocal in the same layout. */
export type MdxModelFn = (x: Float32Array) => Promise<Float32Array> | Float32Array;

export class MdxStream {
  /** STFT frames per segment. */
  readonly frames: number;
  /** Samples per segment, and per block (half of it). */
  readonly segment: number;
  readonly block: number;
  /** Model input, owned by the stream and refreshed in place by `analyze`. */
  readonly x: Float32Array;

  private readonly fft = new FFT(MDX_N_FFT);
  private readonly win = new Float64Array(MDX_N_FFT);
  private readonly re = new Float64Array(MDX_N_FFT);
  private readonly im = new Float64Array(MDX_N_FFT);
  /** Current segment, [L: N][R: N]; the first half is the previous block. */
  private readonly seg: Float32Array;
  /** iSTFT overlap-add of one segment. */
  private readonly acc: Float64Array;
  /** 1 / Σw² over the 64 frames where it is > 1e-10, else 1 (scipy leaves those samples unnormalised). */
  private readonly norm: Float64Array;
  /** Segment cross-fade window, periodic Hann over N. */
  private readonly cw: Float64Array;
  /** Windowed second half of the previous segment's output, [L: H][R: H]. */
  private readonly tail: Float32Array;

  constructor(frames: number = MDX_T) {
    const N = mdxSegment(frames);
    this.frames = frames;
    this.segment = N;
    this.block = N / 2;
    this.x = new Float32Array(4 * MDX_BINS * frames);
    this.seg = new Float32Array(2 * N);
    this.acc = new Float64Array(2 * N);
    this.norm = new Float64Array(N);
    this.cw = new Float64Array(N);
    this.tail = new Float32Array(N);
    for (let i = 0; i < MDX_N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / MDX_N_FFT);
    const env = new Float64Array(N);
    for (let t = 0; t < frames; t++) for (let n = 0; n < MDX_N_FFT; n++) env[t * MDX_HOP + n] += this.win[n] * this.win[n];
    for (let i = 0; i < N; i++) {
      this.norm[i] = env[i] > 1e-10 ? 1 / env[i] : 1;
      this.cw[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    }
  }

  reset(): void {
    this.x.fill(0);
    this.seg.fill(0);
    this.tail.fill(0);
  }

  /** Block b in (`inL`/`inR`: H samples): slide the segment, STFT its frames into `x`. */
  analyze(inL: Float32Array, inR: Float32Array): void {
    const { frames: T, segment: N, block: H } = this;
    const { x, re, im, win, fft, seg } = this;
    seg.copyWithin(0, H, N);
    seg.copyWithin(N, N + H, 2 * N);
    seg.set(inL.subarray(0, H), H);
    seg.set(inR.subarray(0, H), N + H);
    for (let t = 0; t < T; t++) {
      const s = t * MDX_HOP;
      for (let n = 0; n < MDX_N_FFT; n++) {
        re[n] = seg[s + n] * win[n];
        im[n] = seg[N + s + n] * win[n];
      }
      fft.transform(re, im);
      for (let k = 0; k < MDX_BINS; k++) {
        const nk = (MDX_N_FFT - k) & (MDX_N_FFT - 1);
        // two real signals in one complex FFT
        const i = k * T + t;
        x[i] = 0.5 * (re[k] + re[nk]); // Re L
        x[MDX_BINS * T + i] = 0.5 * (im[k] - im[nk]); // Im L
        x[2 * MDX_BINS * T + i] = 0.5 * (im[k] + im[nk]); // Re R
        x[3 * MDX_BINS * T + i] = -0.5 * (re[k] - re[nk]); // Im R
      }
    }
  }

  /**
   * Model output `v` for the segment `analyze` just built → the vocal block for input
   * [(b − 1)·H, b·H) (b = 0: the left pad, silent), written to outL/outR (H samples each).
   */
  synthesize(v: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const { frames: T, segment: N, block: H } = this;
    const { re, im, win, fft, acc, norm, cw, tail } = this;
    const P = MDX_BINS * T;
    acc.fill(0);
    for (let t = 0; t < T; t++) {
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < MDX_BINS; k++) {
        const i = k * T + t;
        const a = v[i], b = k > 0 ? v[P + i] : 0; // DC is real (irfft drops its imaginary part)
        const c = v[2 * P + i], d = k > 0 ? v[3 * P + i] : 0;
        re[k] = a - d;
        im[k] = b + c;
        if (k > 0) {
          re[MDX_N_FFT - k] = a + d;
          im[MDX_N_FFT - k] = c - b;
        }
      }
      fft.transform(re, im, true);
      const s = t * MDX_HOP;
      for (let n = 0; n < MDX_N_FFT; n++) {
        acc[s + n] += (re[n] * win[n]) / MDX_N_FFT;
        acc[N + s + n] += (im[n] * win[n]) / MDX_N_FFT;
      }
    }
    for (let i = 0; i < H; i++) {
      const a = i, b = H + i;
      outL[i] = tail[i] + acc[a] * norm[a] * cw[a];
      outR[i] = tail[H + i] + acc[N + a] * norm[a] * cw[a];
      tail[i] = acc[b] * norm[b] * cw[b];
      tail[H + i] = acc[N + b] * norm[b] * cw[b];
    }
  }

  /** analyze + model + synthesize. */
  async process(inL: Float32Array, inR: Float32Array, model: MdxModelFn, outL: Float32Array, outR: Float32Array): Promise<void> {
    this.analyze(inL, inR);
    const v = await model(this.x);
    this.synthesize(v, outL, outR);
  }
}
