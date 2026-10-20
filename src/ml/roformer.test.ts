import { describe, expect, it } from 'vitest';
import { ROF_BLOCK, ROF_CHUNK, ROF_OVERLAP } from '../worklet/protocol';
import { DEFAULT_ROF_GEOMETRY, RoformerStream, SW_BASE_GEOMETRY, type RoformerMeta } from './roformer';
import { makeGeometry } from './rof-plan';

const ROF_FRAMES = DEFAULT_ROF_GEOMETRY.frames;

const H = ROF_BLOCK, R = ROF_OVERLAP, K = ROF_CHUNK - ROF_BLOCK;
const BINS = 1025;

/** Every (bin, channel) value goes to the model once, covered by one band: masks of 1 give the identity. */
const meta: RoformerMeta = {
  nFft: 2048,
  hop: 441,
  sel: Array.from({ length: 2 * BINS }, (_, i) => i),
  bands: Array.from({ length: BINS }, () => 1),
};

const sineL = (n: number) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / 44100) + 0.1 * Math.sin((2 * Math.PI * 3000 * n) / 44100);
const sineR = (n: number) => 0.4 * Math.cos((2 * Math.PI * 1000 * n) / 44100) + 0.2 * Math.sin((2 * Math.PI * 7000 * n) / 44100);
const block = (f: (n: number) => number, b: number) => Float32Array.from({ length: H }, (_, i) => f(b * H + i));

/** masks of 1 + 0i for every model input value */
const identity = (x: Float32Array): Float32Array => {
  const m = new Float32Array(x.length);
  for (let i = 0; i < m.length; i += 2) m[i] = 1;
  return m;
};

describe('RoformerStream', () => {
  it('geometry: 112 frames, history + block = chunk, overlap smaller than the history', () => {
    expect(ROF_FRAMES).toBe(112);
    expect(DEFAULT_ROF_GEOMETRY.chunk).toBe(ROF_CHUNK);
    expect(K + H).toBe(ROF_CHUNK);
    expect(R).toBeLessThan(K);
  });

  it('another geometry (longer block and overlap, 262 frames) also reproduces the input, delayed by its overlap', async () => {
    const g = makeGeometry(2 * H, 2 * R, 0);
    expect(g.frames).toBeGreaterThan(200);
    const s = new RoformerStream(meta, g);
    expect(s.x.length).toBe(g.frames * 4100);
    const blk = (f: (n: number) => number, b: number) => Float32Array.from({ length: g.block }, (_, i) => f(b * g.block + i));
    const outL = new Float32Array(g.block), outR = new Float32Array(g.block);
    let worst = 0;
    for (let b = 0; b < 3; b++) {
      await s.process(blk(sineL, b), blk(sineR, b), identity, outL, outR);
      if (b === 0) continue;
      for (let i = 0; i < g.block; i++) worst = Math.max(worst, Math.abs(outL[i] - sineL(b * g.block - g.overlap + i)), Math.abs(outR[i] - sineR(b * g.block - g.overlap + i)));
    }
    expect(worst).toBeLessThan(2e-4);
  });

  it('STFT matches torch.stft (n_fft 2048, hop 441, hann, centre reflect) on a two-block signal', () => {
    const s = new RoformerStream(meta);
    s.analyze(block(sineL, 0), block(sineR, 0));
    s.analyze(block(sineL, 1), block(sineR, 1)); // the chunk is now signal [H − K, 2H)
    const at = (ch: number, t: number, k: number) => {
      const j = 2 * k + ch; // identity sel: value j is bin j >> 1, channel j & 1
      return [s.x[t * 4100 + 2 * j], s.x[t * 4100 + 2 * j + 1]];
    };
    const want: [number, number, number, number, number][] = [
      [0, 0, 20, 50.790184020996094, -1.264044112758711e-5],
      [0, 50, 21, -121.3265380859375, -167.99444580078125],
      [0, 111, 140, -36.991554260253906, -16.948638916015625],
      [1, 3, 47, 159.525390625, 47.965187072753906],
      [1, 60, 325, 90.75331115722656, 46.52650451660156],
      [1, 111, 1, 0.6536170244216919, 0.0020132954232394695],
      [0, 7, 0, -0.017839839681982994, 0],
    ];
    for (const [ch, t, k, re, im] of want) {
      const [gr, gi] = at(ch, t, k);
      expect(gr).toBeCloseTo(re, 2);
      expect(gi).toBeCloseTo(im, 2);
    }
  });

  it('masks of 1 reproduce the input, delayed by the overlap R, from the second block on', async () => {
    const s = new RoformerStream(meta);
    const outL = new Float32Array(H), outR = new Float32Array(H);
    let worst = 0;
    for (let b = 0; b < 4; b++) {
      await s.process(block(sineL, b), block(sineR, b), identity, outL, outR);
      if (b === 0) continue; // the first chunk has silence in front of it
      // block b is input [b·H − R, (b + 1)·H − R)
      for (let i = 0; i < H; i++) {
        const n = b * H - R + i;
        worst = Math.max(worst, Math.abs(outL[i] - sineL(n)), Math.abs(outR[i] - sineR(n)));
      }
    }
    expect(worst).toBeLessThan(2e-4);
  });

  it('a mask of 0.5 halves the signal', async () => {
    const s = new RoformerStream(meta);
    const half = (x: Float32Array) => identity(x).map((v) => v * 0.5);
    const outL = new Float32Array(H), outR = new Float32Array(H);
    await s.process(block(sineL, 0), block(sineR, 0), half, outL, outR);
    await s.process(block(sineL, 1), block(sineR, 1), half, outL, outR);
    const n = H - R + 5000;
    expect(outL[5000]).toBeCloseTo(0.5 * sineL(n), 4);
  });

  it('overlapping bands: the masks of the bands that cover a bin are averaged', async () => {
    // every value is sent twice (two "bands"); masks 1 and 0 average to 0.5
    const twice: RoformerMeta = { ...meta, sel: [...meta.sel, ...meta.sel], bands: meta.bands.map(() => 2) };
    const s = new RoformerStream(twice);
    const m = (x: Float32Array) => {
      const out = new Float32Array(x.length);
      const fin = x.length / ROF_FRAMES;
      for (let t = 0; t < ROF_FRAMES; t++) for (let i = 0; i < fin / 2; i += 2) out[t * fin + i] = 1; // first copy: 1, second copy: 0
      return out;
    };
    const outL = new Float32Array(H), outR = new Float32Array(H);
    await s.process(block(sineL, 0), block(sineR, 0), m, outL, outR);
    await s.process(block(sineL, 1), block(sineR, 1), m, outL, outR);
    expect(outL[5000]).toBeCloseTo(0.5 * sineL(H - R + 5000), 4);
  });

  it('reset clears the history and the tail', async () => {
    const s = new RoformerStream(meta);
    const a = new Float32Array(H), b = new Float32Array(H);
    await s.process(block(sineL, 3), block(sineR, 3), identity, a, b);
    s.reset();
    const c = new Float32Array(H), d = new Float32Array(H);
    await s.process(block(sineL, 3), block(sineR, 3), identity, c, d);
    expect(Array.from(c.subarray(0, 100))).toEqual(Array.from(a.subarray(0, 100)));
  });

  it('rejects a meta or a geometry that does not fit', () => {
    expect(() => new RoformerStream({ ...meta, hop: 512 })).toThrow();
    expect(() => new RoformerStream(meta, { ...DEFAULT_ROF_GEOMETRY, frames: 111 })).toThrow();
    expect(() => new RoformerStream(meta, { ...DEFAULT_ROF_GEOMETRY, block: DEFAULT_ROF_GEOMETRY.block + 1 })).toThrow();
  });
});

describe('RoformerStream, the all-stems model (hop 512, several stems)', () => {
  const swMeta: RoformerMeta = { ...meta, hop: 512, stems: ['a', 'b', 'c'] };
  /** stem k gets the mask (k + 1) / 4 + 0i: the stems are the input scaled by 0.25, 0.5, 0.75 */
  const scaled = (x: Float32Array): Float32Array => {
    const stems = 3, fin = 4100, F = x.length / fin;
    const m = new Float32Array(F * stems * fin);
    for (let t = 0; t < F; t++) for (let k = 0; k < stems; k++) for (let i = 0; i < fin; i += 2) m[(t * stems + k) * fin + i] = (k + 1) / 4;
    return m;
  };

  it('the base geometry is 112 frames of hop 512', () => {
    expect(SW_BASE_GEOMETRY.hop).toBe(512);
    expect(SW_BASE_GEOMETRY.frames).toBe(112);
    expect(SW_BASE_GEOMETRY.chunk).toBe(111 * 512);
  });

  it('refuses a meta whose hop is not the geometry hop', () => {
    expect(() => new RoformerStream({ ...swMeta, hop: 441 }, SW_BASE_GEOMETRY)).toThrow(/does not match/);
    expect(() => new RoformerStream(swMeta, DEFAULT_ROF_GEOMETRY)).toThrow(/does not match/);
  });

  it('every stem is the input times its mask, delayed by the overlap, from the second block on', async () => {
    const g = SW_BASE_GEOMETRY;
    const s = new RoformerStream(swMeta, g);
    expect(s.stems).toBe(3);
    const blk = (f: (n: number) => number, b: number) => Float32Array.from({ length: g.block }, (_, i) => f(b * g.block + i));
    const outs = [0, 1, 2].map(() => [new Float32Array(g.block), new Float32Array(g.block)] as const);
    let worst = 0;
    for (let b = 0; b < 3; b++) {
      await s.processStems(blk(sineL, b), blk(sineR, b), scaled, outs);
      if (b === 0) continue;
      for (let k = 0; k < 3; k++) for (let i = 0; i < g.block; i++) {
        const n = b * g.block - g.overlap + i;
        worst = Math.max(worst, Math.abs(outs[k][0][i] - ((k + 1) / 4) * sineL(n)), Math.abs(outs[k][1][i] - ((k + 1) / 4) * sineR(n)));
      }
    }
    expect(worst).toBeLessThan(2e-4);
  });

  it('a stem that is not asked for is skipped, and the others do not change', async () => {
    const g = SW_BASE_GEOMETRY;
    const a = new RoformerStream(swMeta, g), b = new RoformerStream(swMeta, g);
    const blk = (f: (n: number) => number, i: number) => Float32Array.from({ length: g.block }, (_, j) => f(i * g.block + j));
    const mk = () => [new Float32Array(g.block), new Float32Array(g.block)] as const;
    const all = [mk(), mk(), mk()], some = [mk(), undefined, mk()];
    for (let i = 0; i < 3; i++) {
      await a.processStems(blk(sineL, i), blk(sineR, i), scaled, all);
      await b.processStems(blk(sineL, i), blk(sineR, i), scaled, some);
    }
    expect(Array.from(some[0]![0])).toEqual(Array.from(all[0][0]));
    expect(Array.from(some[2]![1])).toEqual(Array.from(all[2][1]));
  });
});
