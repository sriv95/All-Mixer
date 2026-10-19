import { describe, expect, it } from 'vitest';
import { GUITAR_BLOCK, GUITAR_MAX_BLOCK, GUITAR_OVERLAP, GuitarStage, guitarBlockFor, guitarGeometry, stageShape } from './guitar-stage';
import { framesFor } from './rof-plan';
import { withDrums, type BlockEngine } from './drum-engine';
import type { RoformerMeta } from './roformer';

const BINS = 1025;
const meta: RoformerMeta = { nFft: 2048, hop: 441, sel: Array.from({ length: 2 * BINS }, (_, i) => i), bands: Array.from({ length: BINS }, () => 1) };
/** masks of 1 + 0i for every model input value: the identity */
const identity = (x: Float32Array): Float32Array => {
  const m = new Float32Array(x.length);
  for (let i = 0; i < m.length; i += 2) m[i] = 1;
  return m;
};
const sigL = (n: number) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44100) + 0.1 * Math.sin((2 * Math.PI * 3000 * n) / 44100);
const sigR = (n: number) => 0.4 * Math.cos((2 * Math.PI * 1000 * n) / 44100) + 0.2 * Math.sin((2 * Math.PI * 7000 * n) / 44100);

describe('guitarGeometry', () => {
  it('the chunk holds block + overlap + context', () => {
    const g = guitarGeometry();
    expect(g.frames).toBe(framesFor(GUITAR_BLOCK, GUITAR_OVERLAP));
    expect(g.chunk).toBe((g.frames - 1) * 441);
    expect(g.chunk - g.block - g.overlap).toBeGreaterThanOrEqual(439);
  });
});

describe('guitarBlockFor', () => {
  it('follows the delay limit less the overlap, between 5.5 s and the longest block, in render quanta', () => {
    expect(guitarBlockFor(null)).toBe(guitarBlockFor(2000));
    expect(guitarBlockFor(2000)).toBe(GUITAR_BLOCK); // the default limit gives the shortest block, 5.5 s
    expect(guitarBlockFor(1000)).toBe(GUITAR_BLOCK);
    expect(guitarBlockFor(8000)).toBe(Math.floor((8 * 44100 - GUITAR_OVERLAP) / 128) * 128);
    expect(guitarBlockFor(15000)).toBe(GUITAR_MAX_BLOCK);
    for (const ms of [2000, 5000, 7300, 10000]) expect(guitarBlockFor(ms) % 128).toBe(0);
    expect(guitarBlockFor(10000)).toBeGreaterThan(guitarBlockFor(7000));
  });
});

describe('GuitarStage', () => {
  it(`with identity masks the stage returns the pushed signal, final within lag after each push`, async () => {
    const st = new GuitarStage(meta);
    expect(st.lag).toBe(stageShape(guitarGeometry()).lag);
    const H = 30 * 128; // pushes of an engine block, not a multiple of the stage block
    let worst = 0, checked = 0;
    const l = new Float32Array(H), r = new Float32Array(H), ol = new Float32Array(H), or = new Float32Array(H);
    for (let m = 0; m < 280; m++) {
      for (let i = 0; i < H; i++) {
        l[i] = sigL(m * H + i);
        r[i] = sigR(m * H + i);
      }
      await st.push(l, r, H, identity);
      const n = (m + 1) * H;
      const from = n - st.lag; // the engine reads [n − lag, n − lag + H) after pushing H samples at n − H... i.e. up to n − lag + H
      if (from < 2 * st.lag) continue; // the first chunks have no real context yet
      const start = n - H - st.lag;
      st.read(start, H, ol, or);
      for (let i = 0; i < H; i++) {
        worst = Math.max(worst, Math.abs(ol[i] - sigL(start + i)), Math.abs(or[i] - sigR(start + i)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(worst).toBeLessThan(2e-4);
  });

  it('reset starts the stream over', async () => {
    const st = new GuitarStage(meta);
    const H = 20 * 128;
    const l = Float32Array.from({ length: H }, (_, i) => sigL(i)), r = Float32Array.from({ length: H }, (_, i) => sigR(i));
    for (let i = 0; i < 4; i++) await st.push(l, r, H, identity);
    st.reset();
    expect(st.ready).toBe(-GUITAR_OVERLAP);
    const o = new Float32Array(H);
    st.read(0, H, o, new Float32Array(H));
    expect(o.every((v) => v === 0)).toBe(true);
  });

  it('works under withDrums: the reply is older by the lag and carries the guitar of the same samples', async () => {
    const H = 40 * 128, Ro = 12 * 128;
    const inner: BlockEngine = {
      block: H,
      resultOffset: Ro,
      reset() {},
      async process(d) {
        d.fill(0, 0, 4 * H); // Vk = vocal = 0: the instrumental is the input
      },
    };
    const lag = stageShape(guitarGeometry()).lag;
    const e = withDrums(inner, identity, new GuitarStage(meta));
    expect(e.resultOffset).toBe(Ro + lag);
    const d = new Float32Array(6 * H);
    let worst = 0, checked = 0;
    for (let m = 0; m < 190; m++) {
      d.fill(0);
      for (let i = 0; i < H; i++) {
        d[i] = sigL(m * H + i);
        d[H + i] = sigR(m * H + i);
      }
      await e.process(d);
      const first = m * H - lag - Ro; // the reply's first result sample is m·H − lag, which belongs to input sample − Ro
      if (first < 2 * lag) continue;
      for (let i = 0; i < H; i++) {
        worst = Math.max(worst, Math.abs(d[4 * H + i] - sigL(first + i)), Math.abs(d[5 * H + i] - sigR(first + i)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(worst).toBeLessThan(2e-4);
  });
});
