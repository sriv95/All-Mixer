import { describe, expect, it } from 'vitest';
import { FFT } from './fft.js';
import { ML_BLOCK, ML_RESULT_OFFSET } from '../worklet/protocol';
import { BINS, CTX, HOP, N_FFT, P_ACAP, SpleeterStream, TENSOR_LEN, type ModelFn } from './stream';

const ROW = CTX * BINS;

/** Deterministic band-limited test signal: sines below 8 kHz (bin ≈ 743), so bins ≥ 1024 hold nothing. */
function signal(n: number, seed: number): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(n);
  for (let i = 0; i < 40; i++) {
    const f = 60 + rnd() * 7900, ph = rnd() * 6.283, a = 0.02 + rnd() * 0.02;
    for (let j = 0; j < n; j++) out[j] += a * Math.sin((2 * Math.PI * f * j) / 44100 + ph);
  }
  // fade in: a step at n = 0 has energy above 11 kHz, which the mask removes
  for (let j = 0; j < 4096 && j < n; j++) out[j] *= 0.5 - 0.5 * Math.cos((Math.PI * j) / 4096);
  return out;
}

async function run(l: Float32Array, r: Float32Array, model: ModelFn) {
  const st = new SpleeterStream();
  const blocks = l.length / ML_BLOCK;
  const vl = new Float32Array(l.length), vr = new Float32Array(l.length);
  const oL = new Float32Array(ML_BLOCK), oR = new Float32Array(ML_BLOCK);
  for (let b = 0; b < blocks; b++) {
    await st.process(l.subarray(b * ML_BLOCK), r.subarray(b * ML_BLOCK), model, oL, oR);
    const start = b * ML_BLOCK - ML_RESULT_OFFSET;
    for (let i = 0; i < ML_BLOCK; i++) {
      if (start + i >= 0 && start + i < l.length) { vl[start + i] = oL[i]; vr[start + i] = oR[i]; }
    }
  }
  return { vl, vr };
}

const ctxModel: ModelFn = (x) => {
  const v = new Float32Array(TENSOR_LEN);
  for (let c = 0; c < 2; c++)
    for (let r = 0; r < CTX; r++)
      for (let k = 0; k < BINS; k++) {
        const a = x[c * ROW + r * BINS + k];
        const p = r > 0 ? x[c * ROW + (r - 1) * BINS + k] : 0;
        v[c * ROW + r * BINS + k] = (0.3 + 0.6 * ((k % 5) / 5)) * a + 0.1 * p;
      }
  return v;
};

/** Run with setSharpen(a); returns soft (outL/R) and sharp (shL/R) vocal stems on the input time axis. */
async function runSharp(l: Float32Array, r: Float32Array, model: ModelFn, a: number | ((b: number) => number)) {
  const st = new SpleeterStream();
  if (typeof a === 'number') st.setSharpen(a);
  const n = l.length;
  const o = { sl: new Float32Array(n), sr: new Float32Array(n), hl: new Float32Array(n), hr: new Float32Array(n) };
  const oL = new Float32Array(ML_BLOCK), oR = new Float32Array(ML_BLOCK), hL = new Float32Array(ML_BLOCK), hR = new Float32Array(ML_BLOCK);
  for (let b = 0; b < n / ML_BLOCK; b++) {
    if (typeof a === 'function') st.setSharpen(a(b));
    await st.process(l.subarray(b * ML_BLOCK), r.subarray(b * ML_BLOCK), model, oL, oR, hL, hR);
    const start = b * ML_BLOCK - ML_RESULT_OFFSET;
    for (let i = 0; i < ML_BLOCK; i++)
      if (start + i >= 0 && start + i < n) { o.sl[start + i] = oL[i]; o.sr[start + i] = oR[i]; o.hl[start + i] = hL[i]; o.hr[start + i] = hR[i]; }
  }
  return o;
}

describe('SpleeterStream', () => {
  const N = ML_BLOCK * 40;
  const L = signal(N, 1), R = signal(N, 2);

  it('sharpen a = 0: soft output bit-identical to the no-sharpen call, sharp stem = soft, vocal + (x − vocal) = x', async () => {
    const plain = await run(L, R, ctxModel);
    const s = await runSharp(L, R, ctxModel, 0);
    expect(Array.from(s.sl)).toEqual(Array.from(plain.vl));
    expect(Array.from(s.hl)).toEqual(Array.from(s.sl));
    expect(Array.from(s.hr)).toEqual(Array.from(s.sr));
    // worklet mix at 100/100: sharp vocal + (x − soft) = x
    let e = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) e = Math.max(e, Math.abs(s.hl[n] + (L[n] - s.sl[n]) - L[n]));
    expect(e).toBeLessThan(1e-6);
  });

  it('sharpen a = 1: soft stem unchanged, sharp stem = offline reference with mask^P_ACAP, vocal + instrumental ≠ x', async () => {
    const s0 = await runSharp(L, R, ctxModel, 0);
    const s1 = await runSharp(L, R, ctxModel, 1);
    expect(Array.from(s1.sl)).toEqual(Array.from(s0.sl));
    const ref = offline(L, R, ctxModel, P_ACAP);
    let d = 0, diff = 0, sum = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) {
      d = Math.max(d, Math.abs(s1.hl[n] - ref.l[n]), Math.abs(s1.hr[n] - ref.r[n]));
      diff = Math.max(diff, Math.abs(s1.hl[n] - s1.sl[n]));
      sum = Math.max(sum, Math.abs(s1.hl[n] + (L[n] - s1.sl[n]) - L[n]));
    }
    expect(d).toBeLessThan(2e-5);
    expect(diff).toBeGreaterThan(1e-3);
    expect(sum).toBeGreaterThan(1e-3);
  });

  it('sharpen 0.5 uses p_eff = 1 + (P_ACAP − 1)/2', async () => {
    const s = await runSharp(L, R, ctxModel, 0.5);
    const ref = offline(L, R, ctxModel, 1 + (P_ACAP - 1) * 0.5);
    let d = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) d = Math.max(d, Math.abs(s.hl[n] - ref.l[n]));
    expect(d).toBeLessThan(2e-5);
  });

  it('sharpen schedule changes mid-stream: sharp stem = offline reference with per-block p_eff', async () => {
    const sched = (b: number) => (b < 10 ? 0 : b < 20 ? 1 : b < 25 ? 0 : b < 30 ? 0.5 : 0);
    const s = await runSharp(L, R, ctxModel, sched);
    const s0 = await runSharp(L, R, ctxModel, 0);
    expect(Array.from(s.sl)).toEqual(Array.from(s0.sl));
    // frame t of stream block b = t/4 + 1 (synthesize: t = 4b − 4 + f)
    const ref = offline(L, R, ctxModel, (b) => 1 + (P_ACAP - 1) * sched(b));
    let d = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) d = Math.max(d, Math.abs(s.hl[n] - ref.l[n]), Math.abs(s.hr[n] - ref.r[n]));
    expect(d).toBeLessThan(2e-5);
  });

  it('mask 1 → vocal = input delayed by ML_RESULT_OFFSET (bit-close, bins < 1024)', async () => {
    const { vl, vr } = await run(L, R, (x) => x.slice());
    // last ML_RESULT_OFFSET samples are not returned yet
    let dl = 0, dr = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) {
      dl = Math.max(dl, Math.abs(vl[n] - L[n]));
      dr = Math.max(dr, Math.abs(vr[n] - R[n]));
    }
    expect(dl).toBeLessThan(2e-5);
    expect(dr).toBeLessThan(2e-5);
  });

  it('is exactly an input delayed by 5120 (not 4096, not 6144)', async () => {
    expect(ML_RESULT_OFFSET).toBe(5120);
    const { vl } = await run(L, R, (x) => x.slice());
    const err = (d: number) => { let e = 0; for (let n = 8192; n < N - 8192; n++) e = Math.max(e, Math.abs(vl[n] - L[n + d])); return e; };
    expect(err(0)).toBeLessThan(2e-5);
    expect(err(1024)).toBeGreaterThan(1e-3);
  });

  it('zeroes bins ≥ 1024 (they go to the instrumental)', async () => {
    const hi = new Float32Array(N);
    for (let j = 0; j < N; j++) hi[j] = 0.1 * Math.sin((2 * Math.PI * 15000 * j) / 44100);
    const { vl } = await run(hi, hi, (x) => x.slice());
    let m = 0;
    for (let n = 8192; n < N - 8192; n++) m = Math.max(m, Math.abs(vl[n]));
    expect(m).toBeLessThan(1e-4);
  });

  it('matches an offline reference with a context-dependent model (mask clip, row/window mapping)', async () => {
    // v[r] mixes rows r, r−1, r−2 (context), scaled so that masks land both inside and outside [0,1].
    const model: ModelFn = (x) => {
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
    const { vl, vr } = await run(L, R, model);
    const ref = offline(L, R, model);
    let d = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) d = Math.max(d, Math.abs(vl[n] - ref.l[n]), Math.abs(vr[n] - ref.r[n]));
    expect(d).toBeLessThan(2e-5);
    // sanity: the masks actually differ from 1
    let diff = 0;
    for (let n = 0; n < N - ML_RESULT_OFFSET; n++) diff = Math.max(diff, Math.abs(vl[n] - L[n]));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('reset() restarts the stream', async () => {
    const st = new SpleeterStream();
    const id: ModelFn = (x) => x.slice();
    const a = new Float32Array(ML_BLOCK), b = new Float32Array(ML_BLOCK);
    for (let i = 0; i < 5; i++) await st.process(L.subarray(i * ML_BLOCK), R.subarray(i * ML_BLOCK), id, a, b);
    st.reset();
    const first = new Float32Array(ML_BLOCK), fr = new Float32Array(ML_BLOCK);
    await st.process(L, R, id, first, fr);
    const fresh = new SpleeterStream();
    const o1 = new Float32Array(ML_BLOCK), o2 = new Float32Array(ML_BLOCK);
    await fresh.process(L, R, id, o1, o2);
    expect(Array.from(first.subarray(0, 64))).toEqual(Array.from(o1.subarray(0, 64)));
  });
});

/** Naive whole-signal reference of spleeter_stream.separate(--single, h4, L2, ctx64) on the 1024-shifted grid. */
function offline(l: Float32Array, r: Float32Array, model: ModelFn, pwArg: number | ((b: number) => number) = 1) {
  const n = l.length, fft = new FFT(N_FFT);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const nFrames = n / HOP + 4; // frames t = −4 … n/HOP − 1 … covering the stream
  const first = -4;
  const zr: Float64Array[][] = [[], []], zi: Float64Array[][] = [[], []];
  const mag: Float32Array[][] = [[], []];
  const chans = [l, r];
  for (let t = first; t < first + nFrames + 8; t++) {
    for (let c = 0; c < 2; c++) {
      const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
      for (let i = 0; i < N_FFT; i++) {
        const p = HOP * t - 1024 + i;
        re[i] = p >= 0 && p < n ? chans[c][p] * win[i] : 0;
      }
      fft.transform(re, im);
      zr[c][t - first] = re.slice(0, BINS);
      zi[c][t - first] = im.slice(0, BINS);
      mag[c][t - first] = Float32Array.from({ length: BINS }, (_, k) => Math.hypot(re[k], im[k]));
    }
  }
  const out = [new Float64Array(n + 8192), new Float64Array(n + 8192)];
  const off = 4096;
  for (let bp = -1; bp < n / ML_BLOCK; bp++) {
    const x = new Float32Array(TENSOR_LEN);
    for (let c = 0; c < 2; c++)
      for (let row = 0; row < CTX; row++) {
        const t = 4 * bp + 5 - (CTX - 1 - row);
        if (t >= first) x.set(mag[c][t - first], c * ROW + row * BINS);
      }
    const v = model(x) as Float32Array;
    const pw = typeof pwArg === 'function' ? pwArg(bp + 1) : pwArg; // stream block b = bp + 1
    for (let f = 0; f < 4; f++) {
      const t = 4 * bp + f, row = CTX - 4 - 2 + f;
      const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
      const m: number[][] = [[], []];
      for (let c = 0; c < 2; c++)
        for (let k = 0; k < BINS; k++) {
          const q = v[c * ROW + row * BINS + k] / (x[c * ROW + row * BINS + k] + 1e-8);
          m[c][k] = pw === 1 ? Math.min(1, Math.max(0, q)) : Math.min(1, Math.max(0, q)) ** pw;
        }
      for (let k = 0; k < BINS; k++) {
        const a = [zr[0][t - first][k] * m[0][k], zi[0][t - first][k] * m[0][k]];
        const b = [zr[1][t - first][k] * m[1][k], zi[1][t - first][k] * m[1][k]];
        re[k] = a[0] - b[1]; im[k] = a[1] + b[0];
        if (k > 0) { re[N_FFT - k] = a[0] + b[1]; im[N_FFT - k] = b[0] - a[1]; }
      }
      fft.transform(re, im, true);
      for (let i = 0; i < N_FFT; i++) {
        const p = HOP * t - 1024 + i;
        if (p < -off || p >= n + off) continue;
        out[0][p + off] += (re[i] * win[i]) / (1.5 * N_FFT);
        out[1][p + off] += (im[i] * win[i]) / (1.5 * N_FFT);
      }
    }
  }
  return { l: out[0].subarray(off, off + n), r: out[1].subarray(off, off + n) };
}
