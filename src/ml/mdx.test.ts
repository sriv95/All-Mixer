import { describe, expect, it } from 'vitest';
import { MDX_BINS, MDX_T, MdxStream, type MdxModelFn } from './mdx';
import { MDX_SEGMENT, ML_BLOCK } from '../worklet/protocol';

function signal(n: number, seed: number): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(n);
  for (let i = 0; i < 30; i++) {
    const f = 60 + rnd() * 15000, ph = rnd() * 6.283, a = 0.02 + rnd() * 0.02;
    for (let j = 0; j < n; j++) out[j] += a * Math.sin((2 * Math.PI * f * j) / 44100 + ph);
  }
  return out;
}

/** Stream `nb` blocks; the vocal for input [(b − 1)·H, b·H) comes back with block b. Returns it on the input time axis. */
async function run(l: Float32Array, r: Float32Array, model: MdxModelFn, nb: number) {
  const st = new MdxStream();
  const vl = new Float32Array(nb * ML_BLOCK), vr = new Float32Array(nb * ML_BLOCK);
  const oL = new Float32Array(ML_BLOCK), oR = new Float32Array(ML_BLOCK);
  for (let b = 0; b < nb; b++) {
    await st.process(l.subarray(b * ML_BLOCK, (b + 1) * ML_BLOCK), r.subarray(b * ML_BLOCK, (b + 1) * ML_BLOCK), model, oL, oR);
    const start = (b - 1) * ML_BLOCK;
    for (let i = 0; i < ML_BLOCK; i++) if (start + i >= 0) { vl[start + i] = oL[i]; vr[start + i] = oR[i]; }
  }
  return { vl, vr };
}

const NB = 5;
const L = signal(NB * ML_BLOCK, 11), R = signal(NB * ML_BLOCK, 12);

describe('MdxStream', () => {
  it('geometry: T = 64 frames = 68608 samples, hop = N / 2', () => {
    expect(MDX_T).toBe(64);
    expect(MDX_SEGMENT).toBe((MDX_T - 1) * 1024 + 4096);
    expect(ML_BLOCK * 2).toBe(MDX_SEGMENT);
  });

  it('identity model: the stream reproduces the input (STFT, iSTFT / Σw², cross-fade overlap-add), no extra offset', async () => {
    const { vl, vr } = await run(L, R, (x) => x.slice(), NB);
    let d = 0;
    for (let n = 0; n < (NB - 1) * ML_BLOCK; n++) d = Math.max(d, Math.abs(vl[n] - L[n]), Math.abs(vr[n] - R[n]));
    expect(d).toBeLessThan(2e-5);
  });

  it('a longer segment (96 frames, block = 49152) reproduces the input too', async () => {
    const st = new MdxStream(96);
    expect(st.segment).toBe(95 * 1024 + 4096);
    const H = st.block, nb = 4;
    const l = signal(nb * H, 31), r = signal(nb * H, 32);
    const out = new Float32Array(nb * H);
    const oL = new Float32Array(H), oR = new Float32Array(H);
    for (let b = 0; b < nb; b++) {
      await st.process(l.subarray(b * H, (b + 1) * H), r.subarray(b * H, (b + 1) * H), (x) => x.slice(), oL, oR);
      if (b > 0) out.set(oL, (b - 1) * H);
    }
    let d = 0;
    for (let n = 0; n < (nb - 1) * H; n++) d = Math.max(d, Math.abs(out[n] - l[n]));
    expect(d).toBeLessThan(2e-5);
  });

  it('impulse at P comes back at P (offset exactly 0 in the (b − 1)·H result frame)', async () => {
    for (const P of [5, ML_BLOCK - 1, ML_BLOCK, ML_BLOCK + 777, 2 * ML_BLOCK + 40000]) {
      const imp = new Float32Array(NB * ML_BLOCK);
      imp[P] = 1;
      const { vl } = await run(imp, new Float32Array(imp.length), (x) => x.slice(), NB);
      let at = 0;
      for (let n = 0; n < vl.length; n++) if (Math.abs(vl[n]) > Math.abs(vl[at])) at = n;
      expect(at).toBe(P);
      expect(vl[P]).toBeGreaterThan(0.99);
    }
  });

  it('model input layout is [Re L, Im L, Re R, Im R][bin][frame]: a left-only sine sits in the left planes', () => {
    const st = new MdxStream();
    const l = new Float32Array(ML_BLOCK), r = new Float32Array(ML_BLOCK);
    for (let i = 0; i < ML_BLOCK; i++) l[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
    st.analyze(l, r);
    const P = MDX_BINS * MDX_T, t = MDX_T - 1; // last frame lies fully in the block
    const k = Math.round((1000 * 4096) / 44100);
    const mag = (c: number) => Math.hypot(st.x[(2 * c) * P + k * MDX_T + t], st.x[(2 * c + 1) * P + k * MDX_T + t]);
    expect(mag(0)).toBeGreaterThan(100);
    expect(mag(1)).toBeLessThan(1e-3);
  });

  it('reset() restarts the stream', async () => {
    const st = new MdxStream();
    const id: MdxModelFn = (x) => x.slice();
    const a = new Float32Array(ML_BLOCK), b = new Float32Array(ML_BLOCK);
    await st.process(L.subarray(0, ML_BLOCK), R.subarray(0, ML_BLOCK), id, a, b);
    await st.process(L.subarray(ML_BLOCK, 2 * ML_BLOCK), R.subarray(ML_BLOCK, 2 * ML_BLOCK), id, a, b);
    st.reset();
    const o1 = new Float32Array(ML_BLOCK), o2 = new Float32Array(ML_BLOCK);
    await st.process(L.subarray(0, ML_BLOCK), R.subarray(0, ML_BLOCK), id, o1, o2);
    const fresh = new MdxStream();
    const f1 = new Float32Array(ML_BLOCK), f2 = new Float32Array(ML_BLOCK);
    await fresh.process(L.subarray(0, ML_BLOCK), R.subarray(0, ML_BLOCK), id, f1, f2);
    expect(Array.from(o1.subarray(0, 256))).toEqual(Array.from(f1.subarray(0, 256)));
  });
});
