import { describe, expect, it } from 'vitest';
import { withDrums, withStages, type BlockEngine, type SplitStage } from './drum-engine';
import { SC_LAG } from './scnet';

const H = 40 * 128;
const Ro = 12 * 128;
const sig = (ch: number, t: number) => (ch ? 0.4 * Math.cos((2 * Math.PI * 1000 * t) / 44100) : 0.5 * Math.sin((2 * Math.PI * 440 * t) / 44100)) + 0.1 * Math.sin(t * 0.0137);

/** Vocal engine stand-in: Vk and the vocal are half the input of Ro samples ago. */
function fakeInner(): BlockEngine & { resets: number } {
  const hist: number[][] = [[], []];
  const e = {
    block: H,
    resultOffset: Ro,
    resets: 0,
    reset() {
      e.resets++;
      hist[0].length = hist[1].length = 0;
    },
    async process(d: Float32Array) {
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < H; i++) hist[ch].push(d[ch * H + i]);
      const base = hist[0].length - H - Ro; // input index of the first result sample
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < H; i++) {
          const v = 0.5 * (hist[ch][base + i] ?? 0);
          d[ch * H + i] = v; // Vk
          d[(2 + ch) * H + i] = v; // vocal
        }
      }
    },
  };
  return e;
}

describe('withDrums', () => {
  it('the reply is older by SC_LAG and carries Vk, vocal and the drums of the same samples', async () => {
    const e = withDrums(fakeInner(), (x) => x); // identity model: drums = the instrumental = input − Vk = half the input
    expect(e.block).toBe(H);
    expect(e.resultOffset).toBe(Ro + SC_LAG);
    expect(e.planes).toBe(6);
    const d = new Float32Array(6 * H);
    let checked = 0, worst = 0;
    const blocks = Math.ceil((SC_LAG + 4 * H) / H) + 3;
    for (let m = 0; m < blocks; m++) {
      d.fill(0);
      for (let i = 0; i < H; i++) {
        d[i] = sig(0, m * H + i);
        d[H + i] = sig(1, m * H + i);
      }
      await e.process(d);
      const start = m * H - e.resultOffset; // input sample of the first reply sample
      for (let i = 0; i < H; i++) {
        const t = start + i;
        if (t < 0 || m * H < SC_LAG + 2 * H) continue;
        for (const [plane, ch, want] of [[0, 0, 0.5], [1, 1, 0.5], [2, 0, 0.5], [3, 1, 0.5], [4, 0, 0.5], [5, 1, 0.5]] as const) {
          worst = Math.max(worst, Math.abs(d[plane * H + i] - want * sig(ch, t)));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(H);
    expect(worst).toBeLessThan(5e-4);
  });

  it('runs the drum model only when a chunk is complete, not for every block', async () => {
    let runs = 0;
    const e = withDrums(fakeInner(), (x) => (runs++, x));
    const d = new Float32Array(6 * H);
    for (let m = 0; m < 6; m++) await e.process(d);
    expect(runs).toBe(0); // 5120 × 6 samples are less than the 129772 of the first chunk
    for (let m = 6; m < 26; m++) await e.process(d);
    expect(runs).toBe(1); // 26 blocks = 133120 samples: the first chunk is complete, the second needs 108268 more
  });

  it('reset restarts the stream and the inner engine', async () => {
    const inner = fakeInner();
    const e = withDrums(inner, (x) => x);
    const d = new Float32Array(6 * H).fill(0.3);
    await e.process(d);
    e.reset();
    expect(inner.resets).toBe(1);
    d.fill(0);
    await e.process(d);
    expect(d.every((v) => v === 0)).toBe(true); // nothing of the old stream is left in the rings
  });

  it('passes the inner misses and afterReply through', async () => {
    let after = 0;
    const e = withDrums({ ...fakeInner(), misses: () => 7, afterReply: async () => void after++ }, (x) => x);
    expect(e.misses!()).toBe(7);
    await e.afterReply!();
    expect(after).toBe(1);
  });
});

/** A stage that hands back `scale` times what it was given, `lag` samples after the push. */
function fakeStage(lag: number, scale: number): SplitStage & { pushes: number } {
  const l: number[] = [], r: number[] = [];
  const s = {
    lag,
    pushes: 0,
    reset() {
      l.length = r.length = 0;
    },
    async push(a: Float32Array, b: Float32Array, n: number) {
      s.pushes++;
      for (let i = 0; i < n; i++) {
        l.push(scale * a[i]);
        r.push(scale * b[i]);
      }
    },
    read(start: number, n: number, outL: Float32Array, outR: Float32Array) {
      for (let i = 0; i < n; i++) {
        outL[i] = start + i >= 0 ? l[start + i] : 0;
        outR[i] = start + i >= 0 ? r[start + i] : 0;
      }
    },
  };
  return s;
}

describe('withStages', () => {
  it('two stages: 8 planes, the longest lag, each stage handed the same instrumental and read at the same samples', async () => {
    const a = fakeStage(3 * H, 1), b = fakeStage(5 * H, 0.5);
    const e = withStages(fakeInner(), [{ stage: a, run: (x) => x }, { stage: b, run: (x) => x }]);
    expect(e.planes).toBe(8);
    expect(e.resultOffset).toBe(Ro + 5 * H);
    const d = new Float32Array(8 * H);
    let checked = 0, worst = 0;
    for (let m = 0; m < 14; m++) {
      d.fill(0);
      for (let i = 0; i < H; i++) {
        d[i] = sig(0, m * H + i);
        d[H + i] = sig(1, m * H + i);
      }
      await e.process(d);
      const start = m * H - e.resultOffset;
      if (m * H < 5 * H + 2 * H) continue;
      for (let i = 0; i < H; i++) {
        // the instrumental is half the input (Vk = half), so the stages give 0.5 and 0.25 of it
        for (const [plane, ch, want] of [[4, 0, 0.5], [5, 1, 0.5], [6, 0, 0.25], [7, 1, 0.25]] as const) worst = Math.max(worst, Math.abs(d[plane * H + i] - want * sig(ch, start + i)));
        checked++;
      }
    }
    expect(a.pushes).toBe(14);
    expect(b.pushes).toBe(14);
    expect(checked).toBeGreaterThan(H);
    expect(worst).toBeLessThan(5e-4);
  });

  it('reset resets the engine and every stage', async () => {
    const a = fakeStage(H, 1), b = fakeStage(H, 1);
    const inner = fakeInner();
    const e = withStages(inner, [{ stage: a, run: (x) => x }, { stage: b, run: (x) => x }]);
    await e.process(new Float32Array(8 * H));
    e.reset();
    expect(inner.resets).toBe(1);
    await e.process(new Float32Array(8 * H));
    expect(a.pushes).toBe(2);
  });
});
