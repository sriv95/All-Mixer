import { describe, expect, it } from 'vitest';
import { FFT } from './fft.js';
import { BINS, CTX, HOP, HOP_FRAMES, N_FFT, SPL_BLOCK, SpleeterStream, TENSOR_LEN, type ModelFn } from './stream';

const ROW = CTX * BINS;
const N = 16 * SPL_BLOCK;

/** Deterministic test signal: 40 sines, 60 Hz – 8 kHz. */
function signal(n: number, seed: number): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(n);
  for (let i = 0; i < 40; i++) {
    const f = 60 + rnd() * 7900, ph = rnd() * 6.283, a = 0.02 + rnd() * 0.02;
    for (let j = 0; j < n; j++) out[j] += a * Math.sin((2 * Math.PI * f * j) / 44100 + ph);
  }
  return out;
}
const L = signal(N, 1), R = signal(N, 2);

/** Context-dependent model: v[r] mixes rows r, r−1, r−2, scaled so that masks land inside and outside [0, 1]. */
const ctxModel: ModelFn = (x) => {
  const v = new Float32Array(TENSOR_LEN);
  for (let c = 0; c < 2; c++)
    for (let r = 0; r < CTX; r++)
      for (let k = 0; k < BINS; k++) {
        const a = x[c * ROW + r * BINS + k];
        const p = r > 0 ? x[c * ROW + (r - 1) * BINS + k] : 0;
        const q = r > 1 ? x[c * ROW + (r - 2) * BINS + k] : 0;
        v[c * ROW + r * BINS + k] = (0.2 + 0.9 * ((k % 7) / 7)) * a * 0.9 + 0.35 * (p - q);
      }
  return v;
};

/** Run blocks 0 … nb − 1; returns the mask block and first frame of the last one, plus the model input it saw. */
function run(model: ModelFn, nb: number) {
  const st = new SpleeterStream();
  const m = new Float32Array(HOP_FRAMES * 2 * BINS);
  let t0 = NaN, x = new Float32Array(0);
  for (let b = 0; b < nb; b++) {
    st.analyze(L.subarray(b * SPL_BLOCK, (b + 1) * SPL_BLOCK), R.subarray(b * SPL_BLOCK, (b + 1) * SPL_BLOCK));
    x = st.x.slice();
    t0 = st.masks(model(x) as Float32Array, m);
  }
  return { st, m, t0, x };
}

/** Naive magnitude of STFT frame t (covers input [1024t − 1024, 1024t + 3072), periodic Hann), bins < 1024. */
function mag(sig: Float32Array, t: number): Float32Array {
  const fft = new FFT(N_FFT), re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    const p = HOP * t - HOP + i;
    re[i] = p >= 0 && p < sig.length ? sig[p] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT)) : 0;
  }
  fft.transform(re, im);
  return Float32Array.from({ length: BINS }, (_, k) => Math.hypot(re[k], im[k]));
}

describe('SpleeterStream', () => {
  it('model input rows are the STFT magnitudes of frames 4b + 1 − 63 … 4b + 1 (grid: frame t starts at 1024t − 1024)', () => {
    const b = 12;
    const { x } = run((v) => v.slice(), b + 1);
    let d = 0;
    for (const [c, sig] of [[0, L], [1, R]] as const)
      for (let row = 0; row < CTX; row++) {
        const t = HOP_FRAMES * b + 1 - (CTX - 1 - row);
        const ref = mag(sig, t);
        for (let k = 0; k < BINS; k++) d = Math.max(d, Math.abs(x[c * ROW + row * BINS + k] - ref[k]));
      }
    expect(d).toBeLessThan(2e-3); // magnitudes are up to ~ 40; float32 vs float64
  });

  it('masks cover frames 4b − 4 … 4b − 1 and equal clip(v / (mag + 1e-8), 0, 1) of rows 58 … 61', () => {
    const b = 12;
    const { m, t0, x } = run(ctxModel, b + 1);
    expect(t0).toBe(HOP_FRAMES * b - HOP_FRAMES);
    const v = ctxModel(x) as Float32Array;
    let d = 0, inside = 0, clipped = 0;
    for (let f = 0; f < HOP_FRAMES; f++)
      for (let ch = 0; ch < 2; ch++)
        for (let k = 0; k < BINS; k++) {
          const i = ch * ROW + (CTX - HOP_FRAMES - 2 + f) * BINS + k;
          const q = v[i] / (x[i] + 1e-8);
          const want = Math.min(1, Math.max(0, q));
          d = Math.max(d, Math.abs(m[(f * 2 + ch) * BINS + k] - want));
          if (q > 0 && q < 1) inside++; else clipped++;
        }
    expect(d).toBeLessThan(1e-6);
    expect(inside).toBeGreaterThan(100); // the model reaches both the soft and the clipped range
    expect(clipped).toBeGreaterThan(100);
  });

  it('identity model → mask 1, scaled model → that scale, zero model → 0', () => {
    const one = run((v) => v.slice(), 10).m;
    expect(Math.min(...one.subarray(0, 4 * 2 * BINS).filter((_, i) => i % BINS < 700))).toBeGreaterThan(0.999);
    const half = run((v) => v.map((a) => a * 0.5), 10).m;
    expect(half[3 * 2 * BINS + 100]).toBeCloseTo(0.5, 5);
    expect(Math.max(...run((v) => new Float32Array(v.length), 10).m)).toBe(0);
  });

  it('reset() restarts the stream', () => {
    const st = new SpleeterStream();
    const m = new Float32Array(HOP_FRAMES * 2 * BINS);
    const step = (b: number) => {
      st.analyze(L.subarray(b * SPL_BLOCK, (b + 1) * SPL_BLOCK), R.subarray(b * SPL_BLOCK, (b + 1) * SPL_BLOCK));
      return st.masks(ctxModel(st.x) as Float32Array, m);
    };
    for (let b = 0; b < 5; b++) step(b);
    st.reset();
    expect(st.blockCount).toBe(0);
    expect(step(0)).toBe(-HOP_FRAMES);
    const first = m.slice();
    const fresh = new SpleeterStream();
    fresh.analyze(L.subarray(0, SPL_BLOCK), R.subarray(0, SPL_BLOCK));
    const m2 = new Float32Array(m.length);
    fresh.masks(ctxModel(fresh.x) as Float32Array, m2);
    expect(Array.from(first)).toEqual(Array.from(m2));
  });
});
