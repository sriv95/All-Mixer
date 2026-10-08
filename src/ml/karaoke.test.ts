import { describe, expect, it } from 'vitest';
import { FILL_FLOOR_DB, FILL_HI, FILL_LO, FILL_PEAK_MIN_DB, KARAOKE_FLOOR, KaraokeCombiner } from './karaoke';
import { BINS, HOP, N_FFT } from './stream';

const FR = 40; // frames
const NS = HOP * FR;
const SR = 44100;
const binHz = (k: number) => (k * SR) / N_FFT;

/** Sum of 20 sines at 300 Hz – 5 kHz, deterministic. */
function tones(seed: number, n: number): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(n);
  for (let i = 0; i < 20; i++) {
    const f = 300 + rnd() * 4700, ph = rnd() * 6.283, a = 0.02 + rnd() * 0.02;
    for (let j = 0; j < n; j++) out[j] += a * Math.sin((2 * Math.PI * f * j) / SR + ph);
  }
  return out;
}
/** A sine centred on bin k. */
function bin(k: number, n: number): Float32Array {
  const o = new Float32Array(n);
  for (let j = 0; j < n; j++) o[j] = 0.1 * Math.sin((2 * Math.PI * k * j) / N_FFT);
  return o;
}

/** Run the combiner over NS samples, mono in both channels; `mask` is the Spleeter mask for every bin. */
function run(x: Float32Array, v: Float32Array, mask: number, fill: boolean, g = 0.8) {
  const c = new KaraokeCombiner(g, fill);
  c.writeInput(0, x, x, NS);
  c.writeVocal(0, v, v, NS);
  const blk = new Float32Array(4 * 2 * BINS).fill(mask);
  for (let t0 = 0; t0 < FR + 4; t0 += 4) c.pushMasks(t0, blk);
  c.advance(NS);
  const end = c.completeTo;
  const vk = new Float32Array(end), vz = new Float32Array(end), tmp = new Float32Array(end);
  c.emit(0, end, vk, tmp);
  c.emitVocal(0, end, vz, tmp);
  return { vk, vz, end };
}

describe('KaraokeCombiner dip fill (SRI-237)', () => {
  const x = tones(5, NS);
  const half = x.map((a) => 0.5 * a);
  const zero = new Float32Array(NS);

  it('(a) mask below 0.3 (pause) → g = 0: Vk equals the combine without fill bit for bit, vocal untouched', () => {
    const a = run(x, half, 0.29, true), b = run(x, half, 0.29, false);
    expect(a.end).toBe(b.end);
    for (let n = 0; n < a.end; n++) {
      expect(a.vk[n]).toBe(b.vk[n]);
      expect(a.vz[n]).toBe(half[n]);
    }
  });

  it('(b) g = 1, Vm = 0, ms = 1, tone inside 100 – 1000 Hz → V = Vs = x', () => {
    const k = 40;
    expect(binHz(k)).toBeGreaterThan(binHz(FILL_LO));
    expect(binHz(k)).toBeLessThan(binHz(FILL_HI));
    const t = bin(k, NS), r = run(t, zero, 1, true);
    let d = 0;
    for (let j = 10 * HOP; j < 30 * HOP; j++) d = Math.max(d, Math.abs(r.vz[j] - t[j]));
    expect(d).toBeLessThan(1e-3);
  });

  it('(c) bins outside 100 – 1000 Hz unchanged: tone at 3.2 kHz → vocal 0, Vk bit-identical to no fill', () => {
    const t = bin(300, NS), a = run(t, zero, 1, true), b = run(t, zero, 1, false);
    for (let n = 5 * HOP; n < a.end; n++) { // the tone's onset at sample 0 is broadband: skip the first frames
      expect(a.vz[n]).toBe(0);
      expect(a.vk[n]).toBe(b.vk[n]);
    }
  });

  it('(c2) a vocal already stronger than half of Vs is not filled', () => {
    const t = bin(40, NS), a = run(t, t.map((s) => 0.9 * s), 1, true), b = run(t, t.map((s) => 0.9 * s), 1, false);
    for (let n = 5 * HOP; n < a.end; n++) expect(Math.abs(a.vk[n] - b.vk[n])).toBeLessThan(1e-6); // fill off; the 10 – 13 bin repack only rounds
  });

  it('(d) the running floor does not drift to digital silence in a long silence', () => {
    const c = new KaraokeCombiner(0.8, true);
    const ones = new Float32Array(4 * 2 * BINS).fill(1);
    const loud = tones(3, HOP * 16);
    c.writeInput(0, loud, loud, loud.length);
    c.writeVocal(0, loud, loud, loud.length);
    for (let t = 0; t < 20; t += 4) c.pushMasks(t, ones);
    c.advance(HOP * 16);
    const floorLoud = c.floorDb;
    const sil = new Float32Array(16 * HOP);
    let pos = HOP * 16, pushed = 20;
    for (let i = 0; i < 130; i++) { // 130 × 16 frames = 47 s
      c.writeInput(pos, sil, sil, sil.length);
      c.writeVocal(pos, sil, sil, sil.length);
      for (; pushed < pos / HOP + 20; pushed += 4) c.pushMasks(pushed, ones);
      pos += sil.length;
      c.advance(pos);
      c.release(pos - 2 * sil.length, sil.length);
    }
    expect(c.floorDb).toBeCloseTo(FILL_PEAK_MIN_DB - FILL_FLOOR_DB, 6);
    expect(c.floorDb).toBeLessThanOrEqual(floorLoud);
  });
});

describe('KaraokeCombiner gain floor (SRI-247)', () => {
  const t = bin(300, NS), zero = new Float32Array(NS);
  const settled = (a: Float32Array, b: Float32Array, end: number) => {
    let d = 0;
    for (let n = 10 * HOP; n < end - 5 * HOP; n++) d = Math.max(d, Math.abs(a[n] - b[n]));
    return d;
  };

  it('m = 1: instrumental gain is the floor 0.5, not 1 − g = 0.2 (Vk = 0.5 x)', () => {
    expect(KARAOKE_FLOOR).toBe(0.5);
    const r = run(t, zero, 1, false);
    expect(settled(r.vk, t.map((s) => (1 - KARAOKE_FLOOR) * s), r.end)).toBeLessThan(1e-4);
  });

  it('m = 0: instrumental gain 1 (Vk = 0)', () => {
    const r = run(t, zero, 0, false);
    expect(settled(r.vk, zero, r.end)).toBeLessThan(1e-4);
  });

  it('a cappella output does not depend on the floor path: Vz = MDX vocal bit for bit at m = 1 (no fill)', () => {
    const half = t.map((s) => 0.5 * s), r = run(t, half, 1, false);
    for (let n = 0; n < r.end; n++) expect(r.vz[n]).toBe(half[n]);
  });
});
