import { describe, expect, it, vi } from 'vitest';
import { KARAOKE_G, KARAOKE_GATE_BIN } from './karaoke';
import { MlPipeline, type Models } from './pipeline';
import { ML_ALGO_SAMPLES, ML_BLOCK, ML_LATENCY_SAMPLES, ML_RESULT_OFFSET } from '../worklet/protocol';

const NB = 8;
const N = NB * ML_BLOCK;

/** Band-limited (200 Hz – 6 kHz, bins 18 – 560: inside the Karaoke gate band, below bin 1024) deterministic signal. */
function signal(seed: number): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(N);
  for (let i = 0; i < 30; i++) {
    const f = 200 + rnd() * 5800, ph = rnd() * 6.283, a = 0.02 + rnd() * 0.02;
    for (let j = 0; j < N; j++) out[j] += a * Math.sin((2 * Math.PI * f * j) / 44100 + ph);
  }
  return out;
}
const L = signal(21), R = signal(22);

const identity = (v: Float32Array): Float32Array => v.slice();
const zero = (v: Float32Array): Float32Array => new Float32Array(v.length);

/** Stream all blocks (reply, then catch-up, as the worker does); stems on the input time axis. */
async function run(l: Float32Array, r: Float32Array, models: Models, g?: number, fill = false) {
  const p = new MlPipeline(g, undefined, fill);
  const o = { vk: new Float32Array(N), v: new Float32Array(N), vkR: new Float32Array(N) };
  const a = new Float32Array(ML_BLOCK), b = new Float32Array(ML_BLOCK), c = new Float32Array(ML_BLOCK), d = new Float32Array(ML_BLOCK);
  for (let k = 0; k < NB; k++) {
    a.set(l.subarray(k * ML_BLOCK, (k + 1) * ML_BLOCK));
    b.set(r.subarray(k * ML_BLOCK, (k + 1) * ML_BLOCK));
    await p.process(a, b, models, a, b, c, d); // in place over the input, as the worker does
    const start = k * ML_BLOCK - ML_RESULT_OFFSET;
    for (let i = 0; i < ML_BLOCK; i++) if (start + i >= 0) { o.vk[start + i] = a[i]; o.vkR[start + i] = b[i]; o.v[start + i] = c[i]; }
    await p.catchUp(models.spleeter);
  }
  return o;
}
const maxDiff = (a: Float32Array, b: Float32Array, from: number, to: number, scale = 1): number => {
  let m = 0;
  for (let n = from; n < to; n++) m = Math.max(m, Math.abs(a[n] - scale * b[n]));
  return m;
};
/** Last sample that every returned block covers. */
const END = N - ML_RESULT_OFFSET;

describe('MlPipeline', () => {
  it('latency formula: 68608 + 4096 (Karaoke tail) + 14080 (slack) + 128 = 86912 samples, < 2 s, slack ≥ 2× the 152 ms p95', () => {
    expect(ML_ALGO_SAMPLES).toBe(72704);
    expect(ML_LATENCY_SAMPLES).toBe(86912);
    expect((ML_LATENCY_SAMPLES / 44100) * 1000).toBeLessThan(1971);
    expect(((ML_LATENCY_SAMPLES - ML_ALGO_SAMPLES - 128) / 44100) * 1000).toBeGreaterThanOrEqual(2 * 152);
    // the result of block b is back at input time (b + 1)·H; it is read at (b·H − OFFSET) + LATENCY − 128
    expect(ML_BLOCK + ML_RESULT_OFFSET - 128 + (ML_LATENCY_SAMPLES - ML_ALGO_SAMPLES - 128)).toBeGreaterThan(0);
  });

  it('A cappella stem = MDX vocal, delayed by exactly ML_RESULT_OFFSET (identity MDX: stem = input)', async () => {
    const { v } = await run(L, R, { mdx: identity, spleeter: zero });
    expect(maxDiff(v, L, 0, END)).toBeLessThan(5e-5);
    // exactly this offset: shifted by a hop it is not the input any more
    expect(maxDiff(v, L, 8192, END - 1024, 1) < 5e-5 && maxDiff(v.subarray(1024), L, 8192, END - 2048) > 1e-3).toBe(true);
  });

  it('a longer segment (96 frames): the stems come back delayed by its own result offset, and the masks keep up', async () => {
    const frames = 96;
    const p = new MlPipeline(undefined, undefined, false, frames);
    const H = p.block, off = H + 4096, nb = 6;
    expect(H).toBe((frames + 3) * 512);
    const n = nb * H;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin(i * 0.05) + 0.05 * Math.sin(i * 0.31);
    const v = new Float32Array(n);
    const a = new Float32Array(H), b = new Float32Array(H), c = new Float32Array(H), d = new Float32Array(H);
    for (let k = 0; k < nb; k++) {
      a.set(x.subarray(k * H, (k + 1) * H));
      b.set(x.subarray(k * H, (k + 1) * H));
      await p.process(a, b, { mdx: identity, spleeter: zero }, a, b, c, d);
      const start = k * H - off;
      for (let i = 0; i < H; i++) if (start + i >= 0) v[start + i] = c[i];
      await p.catchUp(zero);
    }
    expect(maxDiff(v, x, 0, n - off)).toBeLessThan(5e-5);
    expect(p.splMisses).toBe(0);
  });

  it('impulse in L at P is returned at P in the A cappella stem and at P in Vk (offset == ML_RESULT_OFFSET)', async () => {
    const P = 3 * ML_BLOCK + 1234;
    const imp = new Float32Array(N);
    imp[P] = 1;
    const o = await run(imp, new Float32Array(N), { mdx: identity, spleeter: identity }, 1);
    let at = 0;
    for (let n = 0; n < END; n++) if (Math.abs(o.v[n]) > Math.abs(o.v[at])) at = n;
    expect(at).toBe(P);
    expect(o.v[P]).toBeGreaterThan(0.99);
    // with g = 1 and a mask of 1 the instrumental loses the whole 14 – 1023 band: Vk is the band-limited impulse, peaked at P
    let atK = 0;
    for (let n = 0; n < END; n++) if (Math.abs(o.vk[n]) > Math.abs(o.vk[atK])) atK = n;
    expect(atK).toBe(P);
  });

  it('Karaoke: zero MDX vocal, mask 0 → instrumental = input (Vk = 0)', async () => {
    const { vk } = await run(L, R, { mdx: zero, spleeter: zero });
    expect(maxDiff(vk, new Float32Array(N), 0, END)).toBeLessThan(2e-5);
  });

  it('Karaoke: zero MDX vocal, mask 1 → Vk = g·x in the band (bins 14 … 1023), from sample 2048 on', async () => {
    expect(KARAOKE_GATE_BIN).toBe(14);
    const { vk, vkR } = await run(L, R, { mdx: zero, spleeter: identity });
    // Frame −1 (samples < 2048 only) has no mask in the stream: those samples keep the full band (Vk = 0 there).
    expect(maxDiff(vk, L, 2048, END, 1 - (1 - KARAOKE_G))).toBeLessThan(2e-4);
    expect(maxDiff(vkR, R, 2048, END, 1 - (1 - KARAOKE_G))).toBeLessThan(2e-4);
  });

  it('Karaoke: every sample of every returned block is complete (no gaps between result blocks)', async () => {
    const { vk } = await run(L, R, { mdx: zero, spleeter: identity }, 0.5);
    let nz = 0;
    for (let n = 4096; n < END; n++) if (Math.abs(vk[n]) > 1e-4) nz++;
    expect(nz).toBeGreaterThan(0.99 * (END - 4096));
  });

  it('scheduling: MDX runs first in a block, then only the Spleeter steps the combine needs; the rest after the reply', async () => {
    const order: string[] = [];
    const p = new MlPipeline();
    const models: Models = {
      mdx: (x) => (order.push('mdx'), x.slice()),
      spleeter: (x) => (order.push('spl'), x.slice()),
    };
    const a = new Float32Array(ML_BLOCK), b = new Float32Array(ML_BLOCK), c = new Float32Array(ML_BLOCK), d = new Float32Array(ML_BLOCK);
    for (let k = 0; k < 3; k++) {
      order.length = 0;
      await p.process(a, b, models, a, b, c, d);
      const during = [...order];
      expect(during[0]).toBe('mdx');
      expect(during.filter((s) => s === 'mdx').length).toBe(1);
      const before = order.length;
      await p.catchUp(models.spleeter);
      if (k === 2) expect(order.length).toBeGreaterThan(before); // later blocks leave work for after the reply
      expect(order.slice(before).every((s) => s === 'spl')).toBe(true);
    }
  });

  describe('Spleeter miss (SRI-130)', () => {
    const half = (v: Float32Array): Float32Array => v.map((x) => 0.5 * x);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const outs = () => ({ vk: new Float32Array(N), v: new Float32Array(N) });
    /** Blocks [from, to) through one pipeline; `catchUp` only when asked. */
    async function blocks(p: MlPipeline, models: Models, from: number, to: number, o: ReturnType<typeof outs>, catchUp: boolean) {
      const [a, b, c, d] = [0, 1, 2, 3].map(() => new Float32Array(ML_BLOCK));
      for (let k = from; k < to; k++) {
        a.set(L.subarray(k * ML_BLOCK, (k + 1) * ML_BLOCK));
        b.set(R.subarray(k * ML_BLOCK, (k + 1) * ML_BLOCK));
        await p.process(a, b, models, a, b, c, d);
        const start = k * ML_BLOCK - ML_RESULT_OFFSET;
        for (let i = 0; i < ML_BLOCK; i++) if (start + i >= 0) { o.vk[start + i] = a[i]; o.v[start + i] = c[i]; }
        if (catchUp) await p.catchUp(models.spleeter);
      }
    }

    it('(a) Spleeter that does not answer in time: blocks reply on time, Vk = x − V_mdx exactly as mask 0, vocal unchanged', async () => {
      const never = () => new Promise<Float32Array>(() => {});
      const ref = await run(L, R, { mdx: half, spleeter: zero });
      const p = new MlPipeline(undefined, 5);
      const o = outs();
      // Measure the work, not the wall clock (SRI-257: that flaked under full-suite load): the waits the pipeline
      // asked for must be one 5 ms timer per block; a generous wall-clock bound only catches a hang.
      const asked: number[] = [];
      const real = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (ms === 5) asked.push(ms);
        return real(fn, ms, ...rest);
      }) as typeof setTimeout);
      const t0 = performance.now();
      try {
        await blocks(p, { mdx: half, spleeter: never }, 0, NB, o, false);
      } finally {
        spy.mockRestore();
      }
      expect(asked.length).toBeLessThanOrEqual(NB); // at most one 5 ms wait per block, not forever
      expect(asked.length).toBeGreaterThan(0);
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(p.splMisses).toBeGreaterThan(0);
      for (let n = 0; n < END; n++) { expect(o.vk[n]).toBe(ref.vk[n]); expect(o.v[n]).toBe(ref.v[n]); }
      expect(maxDiff(o.v, L, 0, END, 0.5)).toBeLessThan(5e-5); // MDX vocal unchanged
      expect(maxDiff(o.vk, L, 4096, END, 0.5)).toBeLessThan(2e-4); // x − V = 0.5x, ungated
    });

    it('(b) after the late masks arrive, later frames are gated again', async () => {
      let hold: (() => void) | null = null;
      let late = true;
      const spl: Models['spleeter'] = (v) => (late ? new Promise<Float32Array>((r) => (hold = () => r(v.slice()))) : Promise.resolve(v.slice()));
      const models: Models = { mdx: zero, spleeter: spl };
      const p = new MlPipeline(undefined, 5, false);
      const o = outs();
      await blocks(p, models, 0, 3, o, false); // step 0 hangs: masks missing
      expect(p.splMisses).toBeGreaterThan(0);
      late = false;
      hold!(); // the late step finishes, the rest follows (catch-up, in order)
      await p.catchUp(models.spleeter);
      await blocks(p, models, 3, NB, o, true);
      // early samples ungated (Vk = 0 with mdx = 0), late ones gated (Vk = g·x)
      expect(maxDiff(o.vk, new Float32Array(N), 4096, 2 * ML_BLOCK - ML_RESULT_OFFSET)).toBeLessThan(2e-5);
      expect(maxDiff(o.vk, L, 5 * ML_BLOCK, END, 1 - (1 - KARAOKE_G))).toBeLessThan(2e-4);
    });

    it('(c) normal path (masks in time) is bit-identical to the unbounded wait: no misses', async () => {
      const a = await run(L, R, { mdx: half, spleeter: identity }, undefined, true);
      const p = new MlPipeline(undefined, 50);
      const o = outs();
      await blocks(p, { mdx: half, spleeter: (v) => sleep(0).then(() => v.slice()) }, 0, NB, o, true);
      expect(p.splMisses).toBe(0);
      for (let n = 0; n < END; n++) { expect(o.vk[n]).toBe(a.vk[n]); expect(o.v[n]).toBe(a.v[n]); }
    });
  });
});
